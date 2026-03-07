import type { OpenClawPluginDefinition, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { AuditConfigSchema, type AuditConfig } from "./config-schema.js";
import {
  buildLlmRequestEvent,
  buildLlmResponseEvent,
  buildSessionEndEvent,
  buildSessionStartEvent,
  buildSkillInstallEvent,
  buildToolBlockedEvent,
  buildToolCallEvent,
  buildToolResultEvent,
  buildUserMessageEvent,
} from "./event-builder.js";
import { InterceptionEngine } from "./interception.js";
import { AuditRedactor } from "./redact.js";
import { CompositeAuditSink } from "./sinks/composite.js";
import { FileAuditSink } from "./sinks/file.js";
import { McpAuditSink } from "./sinks/mcp.js";
import { WebhookAuditSink } from "./sinks/webhook.js";
import type { AuditEvent, AuditEventKind, AuditSink } from "./types.js";

// ============================================================
// Config resolution
// ============================================================

function resolveAuditConfig(pluginConfig: unknown): AuditConfig | null {
  const result = AuditConfigSchema.safeParse(pluginConfig ?? {});
  if (!result.success) {
    process.stderr.write(
      `[audit] invalid config: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}\n`,
    );
    return null;
  }
  return result.data;
}

function buildSink(cfg: AuditConfig, log: (msg: string) => void): AuditSink {
  const sinks: AuditSink[] = [];

  // File sink (enabled by default when sinks.file is omitted)
  const fileCfg = cfg.sinks?.file;
  if (fileCfg === undefined || fileCfg.enabled !== false) {
    const path = fileCfg?.path ?? "~/.openclaw/audit/audit.jsonl";
    sinks.push(
      new FileAuditSink({
        path,
        maxFileBytes: fileCfg?.maxFileBytes ?? 200 * 1024 * 1024,
        retentionDays: fileCfg?.retentionDays ?? 90,
      }),
    );
    log(`audit: file sink enabled → ${path}`);
  }

  // Webhook sink
  const webhookCfg = cfg.sinks?.webhook;
  if (webhookCfg?.enabled) {
    sinks.push(
      new WebhookAuditSink({
        url: webhookCfg.url,
        headers: webhookCfg.headers,
        timeoutMs: webhookCfg.timeoutMs ?? 5000,
        maxRetries: webhookCfg.maxRetries ?? 3,
        maxQueueSize: webhookCfg.maxQueueSize ?? 1000,
        batchIntervalMs: webhookCfg.batchIntervalMs ?? 500,
        batchMaxSize: webhookCfg.batchMaxSize ?? 20,
      }),
    );
    log(`audit: webhook sink enabled → ${webhookCfg.url}`);
  }

  // MCP sink
  const mcpCfg = cfg.sinks?.mcp;
  if (mcpCfg?.enabled) {
    sinks.push(
      new McpAuditSink({
        transport: mcpCfg.transport,
        toolName: mcpCfg.toolName ?? "submit_audit_log",
        maxRetries: mcpCfg.maxRetries ?? 3,
        maxQueueSize: mcpCfg.maxQueueSize ?? 500,
        batchIntervalMs: mcpCfg.batchIntervalMs ?? 2_000,
        batchMaxSize: mcpCfg.batchMaxSize ?? 50,
      }),
    );
    const transportDesc =
      mcpCfg.transport.kind === "mcporter"
        ? `mcporter:${mcpCfg.transport.serverName}.${mcpCfg.toolName ?? "submit_audit_log"}`
        : `stdio:${mcpCfg.transport.command} → ${mcpCfg.toolName ?? "submit_audit_log"}`;
    log(`audit: mcp sink enabled → ${transportDesc}`);
  }

  if (sinks.length === 0) {
    log("audit: warning — no sinks configured, audit events will be discarded");
  }

  return new CompositeAuditSink(sinks);
}

// ============================================================
// Event filter
// ============================================================

function makeEventFilter(cfg: AuditConfig): (kind: AuditEventKind) => boolean {
  const allowed = cfg.eventFilter;
  if (!allowed || allowed.length === 0) {
    return () => true;
  }
  const set = new Set<AuditEventKind>(allowed);
  return (kind) => set.has(kind);
}

// ============================================================
// Plugin definition
// ============================================================

const auditPlugin: OpenClawPluginDefinition = {
  id: "audit",
  name: "Enterprise Audit",
  description: "Structured audit log and tool interception for enterprise deployments",

  register(api: OpenClawPluginApi) {
    const cfg = resolveAuditConfig(api.pluginConfig);
    if (!cfg) {
      api.logger.warn("audit: invalid config, plugin disabled");
      return;
    }
    if (!cfg.enabled) {
      api.logger.info?.("audit: disabled (set audit.enabled=true to activate)");
      return;
    }

    const log = (msg: string) => api.logger.info(msg);
    const sink = buildSink(cfg, log);
    const shouldEmit = makeEventFilter(cfg);
    const redactor = new AuditRedactor(cfg);
    const engine = new InterceptionEngine({
      useDefaultRules: cfg.interception?.useDefaultRules !== false,
      customRules: cfg.interception?.rules,
      commandPolicy: cfg.commandPolicy,
    });

    function emit(event: AuditEvent): void {
      if (!shouldEmit(event.kind)) return;
      try {
        const result = sink.write(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            api.logger.error(`audit: sink write error: ${String(err)}`);
          });
        }
      } catch (err) {
        api.logger.error(`audit: sink write error: ${String(err)}`);
      }
    }

    // ① User message received
    api.on("message_received", (event, ctx) => {
      emit(buildUserMessageEvent(event, ctx, cfg));
    });

    // ② LLM request dispatched
    api.on("llm_input", (event, ctx) => {
      emit(buildLlmRequestEvent(event, ctx));
    });

    // ③ LLM response received
    api.on("llm_output", (event, ctx) => {
      emit(buildLlmResponseEvent(event, ctx));
    });

    // ④ Tool call — interception + audit (before_tool_call can return block decision)
    api.on("before_tool_call", (event, ctx) => {
      const interceptEnabled = cfg.interception?.enabled === true;
      const redactedParams = redactor.redactParams(event.params);

      if (interceptEnabled) {
        const decision = engine.evaluate({
          toolName: event.toolName,
          params: event.params,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });

        if (decision.action === "block") {
          emit(buildToolBlockedEvent(event, ctx, decision, redactedParams));
          return { block: true, blockReason: decision.blockMessage };
        }
        // audit_only: falls through to emit tool.call below
      }

      emit(buildToolCallEvent(event, ctx, redactedParams, event.params));
    });

    // ⑤ Tool result
    api.on("after_tool_call", (event, ctx) => {
      emit(buildToolResultEvent(event, ctx, cfg));
    });

    // ⑥ Session lifecycle
    api.on("session_start", (event, ctx) => {
      emit(buildSessionStartEvent(event, ctx));
    });

    api.on("session_end", (event, ctx) => {
      emit(buildSessionEndEvent(event, ctx));
    });

    // ⑦ Skill install audit
    api.on("skill_install", (event, ctx) => {
      emit(buildSkillInstallEvent(event, ctx));
    });

    // ⑧ Graceful shutdown — flush, seal file, close MCP connection
    api.on("gateway_stop", async () => {
      try {
        await sink.close?.();
        log("audit: all sinks flushed and closed");
      } catch (err) {
        api.logger.error(`audit: error closing sinks: ${String(err)}`);
      }
    });

    log(
      `audit: plugin active — interception=${cfg.interception?.enabled ? "on" : "off"}, ` +
        `redact=${cfg.redact?.enabled !== false ? "on" : "off"}`,
    );
  },
};

export default auditPlugin;

// Public exports for users building custom sinks
export type { AuditSink, AuditEvent, AuditEventKind } from "./types.js";
export type { McpTransport } from "./sinks/mcp-transport.js";
export { McporterTransport } from "./sinks/mcp-transport-mcporter.js";
export { StdioTransport } from "./sinks/mcp-transport-stdio.js";
export { McpAuditSink } from "./sinks/mcp.js";
