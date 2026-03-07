import crypto from "node:crypto";
import type {
  AuditEventBase,
  AuditEventKind,
  LlmRequestEvent,
  LlmResponseEvent,
  SessionEndEvent,
  SessionStartEvent,
  SkillInstallEvent,
  ToolBlockedEvent,
  ToolCallEvent,
  ToolResultEvent,
  UserMessageEvent,
} from "./types.js";
import type { AuditConfig } from "./config-schema.js";
import type { InterceptDecision } from "./types.js";
import type {
  PluginHookAgentContext,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
  PluginHookSkillInstallEvent,
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
} from "openclaw/plugin-sdk";

// ============================================================
// Helpers
// ============================================================

function makeBase(
  kind: AuditEventKind,
  ctx: PluginHookAgentContext | PluginHookMessageContext | PluginHookToolContext | PluginHookSessionContext,
): AuditEventBase {
  const now = Date.now();
  const base: AuditEventBase = {
    auditId: crypto.randomUUID(),
    ts: now,
    isoTime: new Date(now).toISOString(),
    kind,
  };

  // Attach whichever context fields are present
  const c = ctx as Record<string, unknown>;
  if (typeof c.agentId === "string") base.agentId = c.agentId;
  if (typeof c.sessionKey === "string") base.sessionKey = c.sessionKey;
  if (typeof c.sessionId === "string") base.sessionId = c.sessionId;
  if (typeof c.channelId === "string") base.channel = c.channelId;
  if (typeof c.accountId === "string") base.accountId = c.accountId;

  return base;
}

type PluginHookSessionContext = { agentId?: string; sessionId: string };

function paramsDigest(params: Record<string, unknown>): string {
  try {
    return crypto.createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

// ============================================================
// Event builders
// ============================================================

export function buildUserMessageEvent(
  event: PluginHookMessageReceivedEvent,
  ctx: PluginHookMessageContext,
  cfg: AuditConfig,
): UserMessageEvent {
  const captureContent = cfg.capture?.userMessageContent === true;
  return {
    ...makeBase("user.message", ctx),
    kind: "user.message",
    content: captureContent ? event.content : null,
    contentLength: event.content.length,
    chatId: ctx.conversationId,
    // from may be "feishu:ou_xxx" or just an open_id — normalize it
    userId: event.from?.replace(/^feishu:/i, "") || undefined,
  };
}

export function buildLlmRequestEvent(
  event: PluginHookLlmInputEvent,
  ctx: PluginHookAgentContext,
): LlmRequestEvent {
  return {
    ...makeBase("llm.request", ctx),
    kind: "llm.request",
    runId: event.runId,
    provider: event.provider,
    model: event.model,
    promptLength: event.prompt.length,
    historyCount: event.historyMessages.length,
    imagesCount: event.imagesCount,
  };
}

export function buildLlmResponseEvent(
  event: PluginHookLlmOutputEvent,
  ctx: PluginHookAgentContext,
  durationMs?: number,
): LlmResponseEvent {
  const totalLength = event.assistantTexts.reduce((sum, t) => sum + t.length, 0);
  return {
    ...makeBase("llm.response", ctx),
    kind: "llm.response",
    runId: event.runId,
    provider: event.provider,
    model: event.model,
    usage: event.usage,
    durationMs,
    assistantTextLength: totalLength,
    success: true,
  };
}

export function buildToolCallEvent(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
  redactedParams: Record<string, unknown>,
  originalParams: Record<string, unknown>,
): ToolCallEvent {
  return {
    ...makeBase("tool.call", ctx),
    kind: "tool.call",
    toolName: event.toolName,
    params: redactedParams,
    paramsDigest: paramsDigest(originalParams),
  };
}

export function buildToolBlockedEvent(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
  decision: InterceptDecision & { action: "block" },
  redactedParams: Record<string, unknown>,
): ToolBlockedEvent {
  return {
    ...makeBase("tool.blocked", ctx),
    kind: "tool.blocked",
    toolName: event.toolName,
    params: redactedParams,
    blockReason: decision.reason,
    ruleId: decision.ruleId,
  };
}

export function buildToolResultEvent(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
  cfg: AuditConfig,
): ToolResultEvent {
  let resultLength: number | undefined;
  if (cfg.capture?.toolResults !== true && event.result !== undefined) {
    // Only record length, not content
    try {
      resultLength = JSON.stringify(event.result).length;
    } catch {
      resultLength = 0;
    }
  }

  return {
    ...makeBase("tool.result", ctx),
    kind: "tool.result",
    toolName: event.toolName,
    durationMs: event.durationMs,
    success: !event.error,
    error: event.error,
    resultLength,
  };
}

export function buildSessionStartEvent(
  event: PluginHookSessionStartEvent,
  ctx: PluginHookSessionContext,
): SessionStartEvent {
  return {
    ...makeBase("session.start", ctx),
    kind: "session.start",
    sessionId: event.sessionId,
    resumedFrom: event.resumedFrom,
  };
}

export function buildSessionEndEvent(
  event: PluginHookSessionEndEvent,
  ctx: PluginHookSessionContext,
): SessionEndEvent {
  return {
    ...makeBase("session.end", ctx),
    kind: "session.end",
    sessionId: event.sessionId,
    messageCount: event.messageCount,
    durationMs: event.durationMs,
  };
}

export function buildSkillInstallEvent(
  event: PluginHookSkillInstallEvent,
  ctx: PluginHookAgentContext,
): SkillInstallEvent {
  return {
    ...makeBase("skill.install", ctx),
    kind: "skill.install",
    skillName: event.skillName,
    installId: event.installId,
    phase: event.phase,
    ok: event.ok,
    warnings: event.warnings ?? [],
    hasCritical: event.hasCritical ?? false,
    blocked: event.blocked ?? false,
    durationMs: event.durationMs,
  };
}
