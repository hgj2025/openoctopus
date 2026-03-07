# 结构化审计模块设计文档

## 1. 目标

为企业内部部署提供符合合规要求的审计能力：
- **可观测性**：用户输入 → LLM 推理 → 工具调用 → 输出，全链路结构化记录
- **执行拦截**：基于策略对工具调用进行阻断或要求审批
- **数据安全**：敏感字段自动脱敏，审计日志与运营日志分离
- **可集成**：支持本地文件 / Webhook 推送 / 自定义 Sink，不侵入核心代码

---

## 2. 集成方式

作为独立 Extension Plugin：`extensions/audit/`

利用现有 Plugin Hook 系统（`src/plugins/types.ts`），**零侵入**挂载：

```
用户消息 ──→ [message_received] ──→ LLM ──→ [llm_input]
                                         ↓
                                    [llm_output] ←── LLM 响应
                                         ↓
                              [before_tool_call] ──→ 工具 ──→ [after_tool_call]
                                    ↑ block?
                              InterceptionEngine
```

每个钩子点：1）记录 AuditEvent 到 Sink；2）对于 `before_tool_call`，可返回 `{ block: true }` 实现拦截。

---

## 3. 模块文件结构

```
extensions/audit/
├── package.json
└── src/
    ├── index.ts              # Plugin 入口，注册所有 hooks
    ├── config-schema.ts      # Zod 配置 Schema
    ├── types.ts              # 所有审计事件类型定义
    ├── event-builder.ts      # 将 Hook 事件 → AuditEvent 的工厂函数
    ├── interception.ts       # 工具拦截策略引擎
    ├── redact.ts             # 审计专用脱敏（复用 core redactSensitiveText）
    ├── writer.ts             # 异步队列写入器（参考 queued-file-writer.ts）
    └── sinks/
        ├── file.ts           # JSONL 文件 Sink（支持滚动）
        ├── webhook.ts        # HTTP POST Sink
        └── composite.ts      # 多 Sink 组合
```

---

## 4. 审计事件类型体系（`types.ts`）

### 4.1 事件基础结构

```typescript
// 所有审计事件的公共字段
type AuditEventBase = {
  // 标识
  auditId: string;          // 事件唯一 ID (crypto.randomUUID)
  ts: number;               // Unix 毫秒时间戳
  isoTime: string;          // ISO 8601 格式（便于人读）

  // 会话溯源
  sessionKey?: string;      // 路由键 (channel:accountId:chatId)
  sessionId?: string;       // 内部 session UUID
  agentId?: string;         // Agent 实例 ID

  // 用户溯源（来自 Feishu 等 channel）
  channel?: string;         // "feishu" | "slack" | ...
  accountId?: string;       // Feishu 账号 ID
  userId?: string;          // 发送方 open_id（来自 message_received ctx）

  // 分类
  kind: AuditEventKind;
};

type AuditEventKind =
  | "user.message"      // 用户发送消息
  | "llm.request"       // 向 LLM 发起推理
  | "llm.response"      // LLM 推理完成
  | "tool.call"         // 工具调用（允许通过）
  | "tool.blocked"      // 工具调用被拦截
  | "tool.result"       // 工具调用结果
  | "session.start"     // 会话开始
  | "session.end"       // 会话结束
  | "access.denied";    // 访问被拒绝（allowlist 未命中等）
```

### 4.2 具体事件类型

```typescript
// 用户消息事件
type UserMessageEvent = AuditEventBase & {
  kind: "user.message";
  content: string;          // 原始消息（可脱敏）
  contentLength: number;    // 原始长度（脱敏后仍保留）
  messageId?: string;       // 平台消息 ID
  chatId?: string;          // 群组/对话 ID
  chatType?: "p2p" | "group";
  senderName?: string;      // 脱敏的发送者名
};

// LLM 推理请求事件
type LlmRequestEvent = AuditEventBase & {
  kind: "llm.request";
  runId: string;
  provider: string;         // "anthropic" | "openai" | ...
  model: string;
  promptLength: number;     // prompt token 估算（不记录原文）
  historyCount: number;     // 历史消息条数
  imagesCount: number;
  // 注意：不记录完整 prompt 内容（合规敏感），仅记录元数据
  // 如需记录，通过 auditConfig.capturePrompts=true 开启并加密存储
};

// LLM 推理响应事件
type LlmResponseEvent = AuditEventBase & {
  kind: "llm.response";
  runId: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    total?: number;
  };
  durationMs?: number;
  assistantTextLength: number;  // 输出长度（不记录内容）
  success: boolean;
  error?: string;
};

// 工具调用事件（已通过拦截）
type ToolCallEvent = AuditEventBase & {
  kind: "tool.call";
  runId?: string;
  toolName: string;
  toolCallId?: string;
  // params 经过脱敏后记录
  params: Record<string, unknown>;
  paramsDigest: string;     // SHA-256(原始params)，用于完整性验证
};

// 工具调用被拦截事件
type ToolBlockedEvent = AuditEventBase & {
  kind: "tool.blocked";
  toolName: string;
  params: Record<string, unknown>;  // 脱敏后
  blockReason: string;
  ruleId?: string;          // 触发的规则 ID
};

// 工具执行结果事件
type ToolResultEvent = AuditEventBase & {
  kind: "tool.result";
  toolName: string;
  toolCallId?: string;
  durationMs?: number;
  success: boolean;
  error?: string;
  resultLength?: number;    // 结果长度（不记录内容，可配置）
};

// 会话事件
type SessionStartEvent = AuditEventBase & {
  kind: "session.start";
  sessionId: string;
  resumedFrom?: string;
};

type SessionEndEvent = AuditEventBase & {
  kind: "session.end";
  sessionId: string;
  messageCount: number;
  durationMs?: number;
};

// 访问拒绝事件（由 Feishu allowlist/policy 模块触发）
type AccessDeniedEvent = AuditEventBase & {
  kind: "access.denied";
  reason: string;           // "allowlist_miss" | "group_policy_disabled" | ...
  userId?: string;
  chatId?: string;
};

// Union type
export type AuditEvent =
  | UserMessageEvent
  | LlmRequestEvent
  | LlmResponseEvent
  | ToolCallEvent
  | ToolBlockedEvent
  | ToolResultEvent
  | SessionStartEvent
  | SessionEndEvent
  | AccessDeniedEvent;
```

---

## 5. 拦截策略引擎（`interception.ts`）

### 5.1 规则 Schema

```typescript
type InterceptAction = "allow" | "block" | "audit_only";

type InterceptRule = {
  id: string;               // 规则唯一 ID，用于日志溯源
  description?: string;

  // 匹配条件（AND 逻辑，所有条件均需满足）
  match: {
    tools?: string[];       // 工具名精确匹配或 glob，如 ["bash", "feishu_perm"]
    toolPattern?: string;   // 正则表达式

    // 基于调用参数匹配（用于细粒度控制）
    params?: {
      // 例：bash 工具中，command 包含 "rm -rf" 时触发
      field: string;        // 参数字段名（支持 dot notation）
      contains?: string;
      matches?: string;     // 正则
    }[];

    // 基于调用方身份匹配
    agentIds?: string[];    // 限定生效的 agent
    channels?: string[];    // 限定生效的 channel
  };

  action: InterceptAction;
  blockMessage?: string;    // 当 action=block 时，返回给 LLM 的拒绝原因
};
```

### 5.2 拦截引擎接口

```typescript
class InterceptionEngine {
  constructor(rules: InterceptRule[]) {}

  // 在 before_tool_call hook 中调用
  evaluate(params: {
    toolName: string;
    params: Record<string, unknown>;
    agentId?: string;
    channel?: string;
    sessionKey?: string;
  }): InterceptDecision;
}

type InterceptDecision =
  | { action: "allow" }
  | { action: "block"; reason: string; ruleId: string; blockMessage: string }
  | { action: "audit_only" };  // 通过但必须记录
```

### 5.3 默认内置规则（企业安全基线）

```typescript
const DEFAULT_ENTERPRISE_RULES: InterceptRule[] = [
  // 拦截对权限管理工具的 remove 操作，防止误删
  {
    id: "perm-remove-guard",
    description: "阻止通过 AI 删除文件权限成员",
    match: { tools: ["feishu_perm"], params: [{ field: "action", contains: "remove" }] },
    action: "block",
    blockMessage: "权限删除操作需要人工在飞书管理后台执行，AI 无法代理此操作。",
  },
  // 高危 bash 命令审计标记
  {
    id: "bash-destructive-audit",
    description: "对潜在破坏性命令额外审计",
    match: {
      tools: ["bash"],
      params: [{ field: "command", matches: "rm\\s+-rf|DROP\\s+TABLE|DELETE\\s+FROM" }],
    },
    action: "audit_only",
  },
];
```

---

## 6. 配置 Schema（`config-schema.ts`）

```typescript
export const AuditConfigSchema = z.object({
  enabled: z.boolean().default(false),

  // Sink 配置（至少一个）
  sinks: z.object({
    file: z.object({
      enabled: z.boolean().default(true),
      path: z.string().default("~/.openclaw/audit/audit.jsonl"),
      maxFileBytes: z.number().default(200 * 1024 * 1024), // 200MB
      retentionDays: z.number().default(90),
    }).optional(),

    webhook: z.object({
      enabled: z.boolean().default(false),
      url: z.string().url(),
      headers: z.record(z.string()).optional(),
      timeoutMs: z.number().default(5000),
      // 失败时不阻塞主流程，异步重试
      maxRetries: z.number().default(3),
    }).optional(),
  }).optional(),

  // 内容捕获开关（默认关闭，避免存储用户对话内容）
  capture: z.object({
    userMessageContent: z.boolean().default(false),   // 是否记录原始消息文本
    llmPromptContent: z.boolean().default(false),      // 是否记录完整 prompt
    toolResults: z.boolean().default(false),           // 是否记录工具返回值
  }).optional(),

  // 脱敏配置
  redact: z.object({
    enabled: z.boolean().default(true),
    // 额外的自定义脱敏规则（追加到默认规则）
    additionalPatterns: z.array(z.string()).optional(),
    // 工具参数中需要脱敏的字段路径
    paramFields: z.array(z.string()).default([
      "token", "secret", "password", "key", "appSecret", "encryptKey",
    ]),
  }).optional(),

  // 拦截规则
  interception: z.object({
    enabled: z.boolean().default(false),
    // 使用内置企业基线规则
    useDefaultRules: z.boolean().default(true),
    // 自定义规则（追加或覆盖）
    rules: z.array(InterceptRuleSchema).optional(),
  }).optional(),

  // 审计日志中包含的事件类型（默认全部）
  eventFilter: z.array(z.enum([
    "user.message", "llm.request", "llm.response",
    "tool.call", "tool.blocked", "tool.result",
    "session.start", "session.end", "access.denied",
  ])).optional(),
}).strict();

export type AuditConfig = z.infer<typeof AuditConfigSchema>;
```

---

## 7. Sink 接口与实现

### 7.1 Sink 抽象

```typescript
export interface AuditSink {
  write(event: AuditEvent): void | Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}
```

### 7.2 文件 Sink（`sinks/file.ts`）

- 复用 `src/agents/queued-file-writer.ts` 的异步队列写入模式
- JSONL 格式，每行一个事件
- 文件按日期滚动（`audit-2026-03-06.jsonl`）
- 支持大小上限（超出时新建 `.1`、`.2` 后缀文件）
- 写入失败不抛出，仅 console.error

### 7.3 Webhook Sink（`sinks/webhook.ts`）

```typescript
// 批量推送模式，避免每个事件一次 HTTP 请求
// - 每 500ms 或积累 20 个事件后批量发送
// - 失败指数退避重试，超过 maxRetries 后丢弃并记录到本地 error log
// - 内存队列上限 1000 个事件（超出时丢弃最旧，防止 OOM）
```

---

## 8. Plugin 入口（`index.ts`）

```typescript
const auditPlugin: OpenClawPluginDefinition = {
  id: "audit",
  name: "Enterprise Audit",

  register(api: OpenClawPluginApi) {
    const auditCfg = resolveAuditConfig(api.config);
    if (!auditCfg.enabled) return;

    const sink = buildCompositeSink(auditCfg);
    const engine = new InterceptionEngine(resolveInterceptRules(auditCfg));
    const redactor = buildRedactor(auditCfg.redact);

    // ① 用户消息入口
    api.on("message_received", (event, ctx) => {
      sink.write(buildUserMessageEvent(event, ctx, auditCfg, redactor));
    });

    // ② LLM 推理请求
    api.on("llm_input", (event, ctx) => {
      sink.write(buildLlmRequestEvent(event, ctx));
    });

    // ③ LLM 推理响应
    api.on("llm_output", (event, ctx) => {
      sink.write(buildLlmResponseEvent(event, ctx));
    });

    // ④ 工具调用拦截 + 审计（核心）
    api.on("before_tool_call", (event, ctx) => {
      const decision = engine.evaluate({
        toolName: event.toolName,
        params: event.params,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      });

      const redactedParams = redactor.redactParams(event.params);

      if (decision.action === "block") {
        // 写入拦截事件
        sink.write(buildToolBlockedEvent(event, ctx, decision, redactedParams));
        // 返回拦截指令给框架
        return { block: true, blockReason: decision.blockMessage };
      }

      // 允许通过，记录调用事件
      sink.write(buildToolCallEvent(event, ctx, redactedParams));
      // action=audit_only 时不做额外处理（已记录）
    });

    // ⑤ 工具执行结果
    api.on("after_tool_call", (event, ctx) => {
      sink.write(buildToolResultEvent(event, ctx, auditCfg));
    });

    // ⑥ 会话生命周期
    api.on("session_start", (event, ctx) => {
      sink.write(buildSessionStartEvent(event, ctx));
    });
    api.on("session_end", (event, ctx) => {
      sink.write(buildSessionEndEvent(event, ctx));
    });
  },
};
```

---

## 9. 数据流与关键设计决策

### 9.1 用户身份溯源问题

`before_tool_call` 的 `ctx` 只有 `agentId`/`sessionKey`，没有直接的 Feishu userId。

解决方案：利用 `sessionKey` 格式（`feishu:accountId:chatId`）提取 channel + accountId，再通过 `sessionKey → userId` 的内存映射：
- 在 `message_received` 时，将 `ctx.conversationId → event.from` 存入 `Map<string, string>`
- 在工具调用时，通过 sessionKey 查询该 Map

### 9.2 异步不阻塞原则

所有 Sink 写入必须异步（`Promise<void>`），且**绝不 throw**：
- 审计日志失败不能影响业务流程
- 但可以通过 `runtime.log.error` 记录 sink 错误
- 关键事件（`tool.blocked`）例外：拦截结果是同步的，Sink 写入是 fire-and-forget

### 9.3 脱敏策略分层

```
Level 1（默认）: 复用 core redactSensitiveText - 自动识别 key/token/secret 模式
Level 2（配置）: 工具参数白名单字段脱敏 - 按字段路径精确脱敏
Level 3（可选）: 完全不记录内容 - captureUserMessageContent=false 时只记录元数据
```

### 9.4 审计日志防篡改（可选增强）

每个 JSONL 文件末尾附加一行 `{ type: "file.seal", hash: SHA-256(all_lines) }`，
便于事后验证文件完整性。

---

## 10. 配置示例

```yaml
# openclaw.config.yaml
plugins:
  - extensions/audit

audit:
  enabled: true

  sinks:
    file:
      enabled: true
      path: "~/.openclaw/audit/audit.jsonl"
      retentionDays: 180
    webhook:
      enabled: true
      url: "https://your-siem.internal/api/audit"
      headers:
        Authorization: "Bearer ${AUDIT_WEBHOOK_TOKEN}"

  capture:
    userMessageContent: false    # 不存储用户原始对话
    llmPromptContent: false
    toolResults: false

  redact:
    enabled: true
    paramFields: ["token", "appSecret", "encryptKey", "password"]

  interception:
    enabled: true
    useDefaultRules: true
    rules:
      # 禁止 AI 直接 git push 到主分支
      - id: "no-git-push-main"
        description: "禁止 AI 直接推送 main/master 分支"
        match:
          tools: ["bash"]
          params:
            - field: "command"
              matches: "git\\s+push.*(main|master)"
        action: "block"
        blockMessage: "禁止直接推送主分支，请先创建 PR。"

      # 记录所有 feishu_doc 写操作（不拦截，仅审计）
      - id: "doc-write-audit"
        match:
          tools: ["feishu_doc"]
          params:
            - field: "action"
              matches: "^(create|update|delete)"
        action: "audit_only"

  eventFilter:
    - "user.message"
    - "tool.call"
    - "tool.blocked"
    - "session.start"
    - "session.end"
```

---

## 11. 输出样例（JSONL）

```jsonl
{"auditId":"01HY...","ts":1741267200000,"isoTime":"2026-03-06T08:00:00.000Z","kind":"session.start","sessionKey":"feishu:default:oc_xxx","sessionId":"sess_abc","agentId":"main","channel":"feishu","accountId":"default","sessionId":"sess_abc","resumedFrom":null}
{"auditId":"01HY...","ts":1741267201000,"isoTime":"2026-03-06T08:00:01.000Z","kind":"user.message","sessionKey":"feishu:default:oc_xxx","userId":"ou_yyy","channel":"feishu","chatType":"p2p","contentLength":42,"messageId":"om_zzz"}
{"auditId":"01HY...","ts":1741267203000,"isoTime":"2026-03-06T08:00:03.000Z","kind":"llm.request","sessionKey":"feishu:default:oc_xxx","runId":"run_001","provider":"anthropic","model":"claude-sonnet-4-6","historyCount":2,"imagesCount":0,"promptLength":1024}
{"auditId":"01HY...","ts":1741267205000,"isoTime":"2026-03-06T08:00:05.000Z","kind":"tool.call","sessionKey":"feishu:default:oc_xxx","toolName":"bash","params":{"command":"git status","cwd":"/workspace/project"},"paramsDigest":"sha256:a1b2..."}
{"auditId":"01HY...","ts":1741267206000,"isoTime":"2026-03-06T08:00:06.000Z","kind":"tool.blocked","sessionKey":"feishu:default:oc_xxx","toolName":"bash","params":{"command":"git push origin main","cwd":"/workspace/project"},"blockReason":"禁止直接推送主分支，请先创建 PR。","ruleId":"no-git-push-main"}
{"auditId":"01HY...","ts":1741267208000,"isoTime":"2026-03-06T08:00:08.000Z","kind":"llm.response","sessionKey":"feishu:default:oc_xxx","runId":"run_001","provider":"anthropic","model":"claude-sonnet-4-6","usage":{"input":1024,"output":256,"total":1280},"durationMs":4200,"assistantTextLength":512,"success":true}
```
