# 飞书 Agent 改造方案

> 目标：基于 OpenClaw 代码库，裁剪并改造为专注飞书渠道的 Agent，支持飞书文档操作、代码阅读、编码、Git 操作，以安全为基础，支持未来灵活扩展。
>
> 分析日期：2026-03-03

---

## 一、现状与目标

### 当前代码体量

| 模块 | 大小 | 场景需求 |
|------|------|---------|
| `src/agents/` | 5.6MB / 688 文件 | ✅ 核心，保留并裁剪 |
| `src/gateway/` | 2.8MB | ✅ 保留，简化 |
| `src/infra/` | 2.4MB | ✅ 保留 |
| `src/auto-reply/` | 2.4MB | ⚠️ 保留基础心跳，裁剪 |
| `src/discord/` + `src/telegram/` + `src/slack/` + `src/line/` 等 | ~5MB | ❌ 全部移除 |
| `src/browser/`（Playwright） | 880KB | ❌ 移除 |
| `src/memory/` | 736KB | ⚠️ 可选，暂缓 |
| `src/cron/` | 660KB | ⚠️ 未来有用，暂保留 |
| `src/canvas-host/` | — | ❌ 移除 |
| `src/tts/` | — | ❌ 移除 |
| `src/pairing/` | — | ❌ 移除 |
| `apps/macos` + `ios` + `android` | 大量 Swift/Kotlin | ❌ 全部移除 |
| `packages/clawdbot` + `moltbot` | — | ❌ 移除 |
| 40+ extensions（非 feishu） | — | ❌ 几乎全部移除 |

### 目标架构

```
openoctopus/
├── src/
│   ├── index.ts                  # 入口
│   ├── cli/                      # 裁剪后的 CLI（只保留 gateway/agent/config 命令）
│   ├── gateway/                  # HTTP+WebSocket 网关（slim）
│   ├── agents/                   # Agent 运行时（核心，保留）
│   ├── channels/                 # Channel 注册表（保留抽象层）
│   ├── routing/                  # 消息路由（简化，去掉多渠道复杂匹配）
│   ├── config/                   # 配置系统（简化 schema）
│   ├── plugins/                  # 插件加载器（保留，是扩展点）
│   ├── plugin-sdk/               # 插件 SDK（保留，供未来扩展）
│   ├── sessions/                 # 会话持久化
│   ├── security/                 # 安全层（webhook 验证、ACL、审计日志）
│   ├── secrets/                  # 密钥管理（env-first 设计）
│   ├── hooks/                    # 钩子系统（保留）
│   ├── process/                  # 进程执行（bash/git 工具需要）
│   ├── media/                    # 媒体（只保留图片处理）
│   ├── markdown/                 # Markdown 工具
│   ├── infra/                    # 基础设施工具
│   ├── logging/                  # 日志
│   ├── shared/ + types/ + utils/ # 公共层
│   └── terminal/                 # 终端 UI
│
├── extensions/
│   ├── feishu/                   # ✅ 主渠道（保留 + 增强）
│   ├── memory-core/              # ✅ 保留（轻量记忆）
│   ├── memory-lancedb/           # ⚙️ 可选（向量搜索，未来启用）
│   ├── diffs/                    # ✅ 保留（代码 diff 展示）
│   └── shared/                   # ✅ 内部共享工具
│
└── （移除）apps/, packages/clawdbot, packages/moltbot, 其余 35+ extensions
```

---

## 二、设计原则

```
安全原则                    实现方式
─────────────────────────────────────────────────
最小权限                    工具白名单 + bash 指令过滤
输入验证                    Feishu webhook 签名 + 用户 ACL
密钥隔离                    env vars 优先，不入 config 文件
审计可追溯                  每次工具调用写 audit log
沙箱隔离                    工作目录锁定 + 执行超时

扩展性原则                  实现方式
─────────────────────────────────────────────────
Plugin SDK 保留             新渠道只需实现 ChannelPlugin 接口
Hook 系统保留               before-agent-start 可注入逻辑
工具注册中心                自定义工具通过插件注册，不改核心
Config-driven               功能开关在 config，不改代码
ACP 子 Agent 保留           支持未来多 Agent 协作工作流
```

---

## 三、分阶段执行计划

### Phase 1 — 物理清理（低风险，优先执行）

**移除 extensions（不影响核心逻辑）：**

```
❌ discord, telegram, slack, signal, whatsapp, imessage, line
❌ msteams, googlechat, matrix, mattermost, nextcloud-talk, tlon, irc
❌ zalo, zalouser, nostr, synology-chat, twitch, bluebubbles
❌ voice-call, talk-voice, phone-control
❌ copilot-proxy, google-gemini-cli-auth, minimax-portal-auth, qwen-portal-auth
❌ lobster, thread-ownership, open-prose, device-pair, diagnostics-otel
❌ llm-task, acpx（暂保留 acp core，去掉 extension）
```

**移除 apps（Swift/Kotlin 原生 app）：**

```
❌ apps/macos, apps/ios, apps/android, apps/shared
```

**移除 packages：**

```
❌ packages/clawdbot, packages/moltbot
```

**移除 src/ 内置渠道（保留 channel 抽象层）：**

```
❌ src/discord/, src/telegram/, src/slack/
❌ src/signal/, src/whatsapp/, src/imessage/, src/line/, src/web/
❌ src/tts/, src/browser/, src/canvas-host/, src/pairing/
❌ src/tui/（TUI 交互界面，CLI 够用）
```

**清理 `package.json` 依赖：**

```
移除：
  @discordjs/voice, @grammyjs/runner, @grammyjs/transformer-throttler
  @slack/bolt, @slack/web-api, @line/bot-sdk
  @whiskeysockets/baileys    # WhatsApp
  @snazzah/davey             # Discord
  grammy                     # Telegram
  opusscript                 # 语音编解码
  node-edge-tts              # TTS
  playwright-core            # 浏览器自动化
  croner                     # 暂时移除（如不用 cron）
```

---

### Phase 2 — 安全加固（核心基础，先于功能扩展）

#### 2.1 飞书 Webhook 安全验证

现有文件：`extensions/feishu/src/monitor.webhook-security.test.ts`

验证清单：
- [ ] HMAC-SHA256 签名验证是否严格（时间戳防重放 ±5min）
- [ ] Challenge 握手验证是否完整
- [ ] 敏感头信息是否有 header-injection 风险
- [ ] 加密消息（encrypt key）解密逻辑是否安全

#### 2.2 访问控制层（ACL）

```yaml
# config.yml 新增
security:
  feishu:
    allowedUserIds:            # 白名单用户 open_id
      - "ou_xxxxxxxxx"
    allowedGroupIds:           # 白名单群组（可选）
      - "oc_xxxxxxxxx"
    requireGroupMention: true  # 群聊必须 @bot
    auditLog:
      enabled: true
      path: "~/.openoctopus/audit.jsonl"
```

基于现有 `src/channels/allowlists/` 扩展飞书专属 ACL。

#### 2.3 工具执行沙箱

基于现有 `src/agents/tool-policy.ts` 加固：

```typescript
tools: {
  allowlist: [
    "read_file",
    "write_file",
    "list_files",
    "bash",           // 受限版本
    "git_status",     // 专用 git 工具（Phase 3 新增）
    "git_diff",
    "git_log",
    "git_commit",
    // feishu 文档工具由插件注入
  ],
  bash: {
    blockedPatterns: [
      "rm -rf",
      "sudo",
      "curl.*\\|.*sh",   // 防止远程代码执行
      "eval",
      "> /dev/",
      "chmod 777",
    ],
    workingDirLocked: true,  // 限制在 workspace 目录内
    timeout: 30000,           // 30s 超时
  }
}
```

#### 2.4 密钥管理（env-first）

当前 `~/.openclaw/config.yml` 中存明文 token，改造为 env 变量优先：

```bash
# 环境变量（优先级最高）
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
FEISHU_VERIFICATION_TOKEN=xxxxxxxx
FEISHU_ENCRYPT_KEY=xxxxxxxx
```

```yaml
# config.yml 中用变量引用
channels:
  feishu:
    appId: "${FEISHU_APP_ID}"
    appSecret: "${FEISHU_APP_SECRET}"
```

在 `src/secrets/` 中添加 env 变量优先读取逻辑：
```
env vars > ~/.openoctopus/secrets.json > config.yml（deprecated warning）
```

#### 2.5 审计日志

在 `src/hooks/` 增加审计钩子，记录：
- 每次工具调用（工具名、参数摘要、执行用户 open_id、时间戳）
- 每次 bash 执行（命令、退出码、耗时）
- 配置变更事件

---

### Phase 3 — Agent 能力增强

#### 3.1 Git 专用工具集

当前 bash 工具可执行 git，但无结构化输出。新增专用 git 工具（建议放在 `extensions/feishu/src/` 或新建 `extensions/git-tools/`）：

```typescript
// 示例：结构化 git 工具
{
  name: "git_status",
  description: "获取 git 仓库当前状态，返回结构化数据",
  inputSchema: { repoPath?: string }
},
{
  name: "git_diff",
  description: "查看文件变更差异",
  inputSchema: { file?: string, staged?: boolean, repoPath?: string }
},
{
  name: "git_log",
  description: "查看提交历史",
  inputSchema: { limit?: number, author?: string, since?: string }
},
{
  name: "git_commit",
  description: "创建 git 提交（需要白名单授权）",
  inputSchema: { message: string, files: string[] }
},
{
  name: "git_branch",
  description: "分支管理（列出/创建/切换）",
  inputSchema: { action: "list" | "create" | "switch", name?: string }
}
```

#### 3.2 代码阅读工具增强

基于现有 `src/agents/pi-tools*.ts`（文件 I/O）扩展：

```typescript
{
  name: "search_in_files",
  description: "在代码库中搜索（ripgrep 封装）",
  inputSchema: { pattern: string, path?: string, fileGlob?: string, caseSensitive?: boolean }
},
{
  name: "list_directory",
  description: "列出目录结构（树形）",
  inputSchema: { path: string, depth?: number, includeHidden?: boolean }
},
{
  name: "read_file_range",
  description: "按行范围读取大文件",
  inputSchema: { path: string, startLine: number, endLine: number }
}
```

#### 3.3 飞书文档工具（已有，验证集成）

`extensions/feishu/src/` 已实现：

| 文件 | 功能 | 状态 |
|------|------|------|
| `docx.ts` | 飞书文档读写 | ✅ 已有，验证工具注入 |
| `wiki.ts` | Wiki 页面 | ✅ 已有 |
| `drive.ts` | 云文档/网盘 | ✅ 已有 |
| `bitable.ts` | 多维表格 | ✅ 已有 |

验证任务：确认以上工具通过 `agentTools` 适配器正确注入到 agent，测试端到端调用链路。

---

### Phase 4 — 配置与运维简化

#### 4.1 精简 Config Schema

清理 `src/config/schema.ts`（当前 370 行）中所有已删除渠道的配置，目标结构：

```yaml
gateway:
  port: 18789
  bind: "127.0.0.1"

agents:
  default: "main"
  main:
    model: "claude-sonnet-4-6"
    workspace: "/path/to/workspace"
    tools:
      allowlist: [...]
      bash:
        blockedPatterns: [...]
        timeout: 30000

channels:
  feishu:
    appId: "${FEISHU_APP_ID}"
    appSecret: "${FEISHU_APP_SECRET}"
    verificationToken: "${FEISHU_VERIFICATION_TOKEN}"
    encryptKey: "${FEISHU_ENCRYPT_KEY}"
    accounts:
      default:
        allowFrom:
          - "ou_xxxxxxxx"    # 白名单用户

security:
  auditLog: true
  toolSandbox: true

memory:
  enabled: false             # 初期关闭，后续开启
```

#### 4.2 精简 CLI 命令

清理 `src/cli/` 中与已删除功能相关的命令，只保留：

```
openoctopus gateway run       # 启动网关
openoctopus agent --message   # 直接调用 agent
openoctopus config set/get    # 配置管理
openoctopus channels status   # 飞书连接状态
openoctopus logs              # 查看日志
```

---

## 四、优先级与工作量

| 优先级 | 任务 | 工作量 | 收益 |
|--------|------|--------|------|
| P0 | Phase 1 物理清理 | 低 | 减少复杂度、加速构建 |
| P0 | Phase 2.1-2.3 Webhook 验证 + ACL + 沙箱 | 中 | 防止误用、数据泄露 |
| P1 | Phase 3.1 Git 工具增强 | 低 | 核心功能 |
| P1 | Phase 4.1 Config 简化 | 中 | 运维友好 |
| P2 | Phase 3.2 代码搜索工具 | 低 | 提升 agent 能力 |
| P2 | Phase 2.4-2.5 密钥管理 + 审计日志 | 中 | 生产就绪 |
| P3 | Phase 4.2 CLI 瘦身 | 低 | 开发体验 |
| P3 | memory-lancedb 向量搜索 | 高 | 未来扩展，非必须 |

---

## 五、飞书 Extension 现有能力清单

`extensions/feishu/src/` 已有文件：

```
accounts.ts          # 账号管理
bitable.ts           # 多维表格工具
bot.ts               # 机器人基础
card-action.ts       # 消息卡片交互
channel.ts           # ChannelPlugin 实现
chat.ts              # 群聊消息处理
client.ts            # Feishu SDK 客户端封装
config-schema.ts     # 配置 schema
dedup.ts             # 消息去重
directory.ts         # 通讯录
doc-schema.ts        # 文档 schema
docx.ts              # 文档 CRUD（含 batch insert / table ops）
drive.ts             # 云盘操作
dynamic-agent.ts     # 动态 agent 路由
external-keys.ts     # 外部 key 映射
media.ts             # 媒体文件处理
mention.ts           # @提及处理
monitor.ts           # 事件订阅监听
onboarding.ts        # 配置引导
outbound.ts          # 消息发送
perm.ts              # 权限管理
policy.ts            # DM 策略
post.ts              # 富文本消息
probe.ts             # 健康探测
reactions.ts         # 消息反应（emoji）
reply-dispatcher.ts  # 回复分发
runtime.ts           # 运行时管理
send.ts              # 消息发送核心
streaming-card.ts    # 流式响应卡片
targets.ts           # 发送目标解析
tool-account.ts      # 工具账号路由
tools-config.ts      # 工具配置
typing.ts            # 输入状态
wiki.ts              # Wiki 操作
```

已有的飞书工具（通过 `agentTools` 注入 agent）：
- 文档读写（`docx.ts`）
- Wiki 读写（`wiki.ts`）
- 多维表格（`bitable.ts`）
- 云盘操作（`drive.ts`）
- 通讯录查询（`directory.ts`）
- 权限管理（`perm.ts`）

---

## 六、参考文件

| 文件 | 用途 |
|------|------|
| `extensions/feishu/` | 飞书渠道插件（主要开发目录） |
| `src/agents/tool-policy.ts` | 工具安全策略 |
| `src/channels/allowlists/` | 用户白名单实现 |
| `src/security/` | SSRF 防护、安全工具 |
| `src/secrets/` | 密钥管理 |
| `src/hooks/` | 生命周期钩子注册点 |
| `src/routing/resolve-route.ts` | 消息路由逻辑 |
| `src/config/schema.ts` | 配置 schema（待精简） |
| `.docs/ARCHITECTURE_ANALYSIS.md` | 架构分析报告（详细）|
