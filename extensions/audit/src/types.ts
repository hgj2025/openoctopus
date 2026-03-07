/**
 * Audit module type definitions.
 * All events are JSONL-serializable and designed to be forwarded to SIEM systems.
 */

// ============================================================
// Base
// ============================================================

export type AuditEventKind =
  | "user.message"
  | "llm.request"
  | "llm.response"
  | "tool.call"
  | "tool.blocked"
  | "tool.result"
  | "session.start"
  | "session.end"
  | "access.denied"
  | "skill.install";

export type AuditEventBase = {
  /** Globally unique event ID (crypto.randomUUID) */
  auditId: string;
  /** Unix millisecond timestamp */
  ts: number;
  /** ISO 8601 timestamp for human readability */
  isoTime: string;
  kind: AuditEventKind;

  // Session tracing
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;

  // User identity (populated from channel context)
  channel?: string;
  accountId?: string;
  /** Feishu open_id or equivalent; never a mutable display name */
  userId?: string;
};

// ============================================================
// Event types
// ============================================================

/** User sent a message to the bot */
export type UserMessageEvent = AuditEventBase & {
  kind: "user.message";
  /** Original content, or null if capture.userMessageContent=false */
  content: string | null;
  contentLength: number;
  messageId?: string;
  chatId?: string;
  chatType?: "p2p" | "group";
};

/** A request was dispatched to the LLM */
export type LlmRequestEvent = AuditEventBase & {
  kind: "llm.request";
  runId: string;
  provider: string;
  model: string;
  /** Estimated prompt length (characters). Full content not recorded by default. */
  promptLength: number;
  historyCount: number;
  imagesCount: number;
};

/** The LLM completed a response */
export type LlmResponseEvent = AuditEventBase & {
  kind: "llm.response";
  runId: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  durationMs?: number;
  assistantTextLength: number;
  success: boolean;
  error?: string;
};

/** A tool call was approved and dispatched */
export type ToolCallEvent = AuditEventBase & {
  kind: "tool.call";
  runId?: string;
  toolName: string;
  toolCallId?: string;
  /** Redacted parameter snapshot */
  params: Record<string, unknown>;
  /** SHA-256 digest of original (pre-redaction) params JSON, for integrity checks */
  paramsDigest: string;
};

/** A tool call was blocked by interception policy */
export type ToolBlockedEvent = AuditEventBase & {
  kind: "tool.blocked";
  toolName: string;
  /** Redacted parameter snapshot */
  params: Record<string, unknown>;
  blockReason: string;
  /** ID of the interception rule that triggered the block */
  ruleId: string;
};

/** A tool call completed (success or error) */
export type ToolResultEvent = AuditEventBase & {
  kind: "tool.result";
  toolName: string;
  toolCallId?: string;
  durationMs?: number;
  success: boolean;
  error?: string;
  /** Length of result content; full content not recorded unless capture.toolResults=true */
  resultLength?: number;
};

export type SessionStartEvent = AuditEventBase & {
  kind: "session.start";
  sessionId: string;
  resumedFrom?: string;
};

export type SessionEndEvent = AuditEventBase & {
  kind: "session.end";
  sessionId: string;
  messageCount: number;
  durationMs?: number;
};

/** Access was denied before reaching the agent (allowlist miss, policy block, etc.) */
export type AccessDeniedEvent = AuditEventBase & {
  kind: "access.denied";
  reason: string;
  chatId?: string;
};

/** A skill install was attempted (phase=before) or completed (phase=after) */
export type SkillInstallEvent = AuditEventBase & {
  kind: "skill.install";
  skillName: string;
  installId: string;
  phase: "before" | "after";
  ok?: boolean;
  warnings: string[];
  hasCritical: boolean;
  blocked: boolean;
  durationMs?: number;
};

export type AuditEvent =
  | UserMessageEvent
  | LlmRequestEvent
  | LlmResponseEvent
  | ToolCallEvent
  | ToolBlockedEvent
  | ToolResultEvent
  | SessionStartEvent
  | SessionEndEvent
  | AccessDeniedEvent
  | SkillInstallEvent;

// ============================================================
// Sink abstraction
// ============================================================

export interface AuditSink {
  write(event: AuditEvent): void | Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

// ============================================================
// Interception
// ============================================================

export type InterceptAction = "allow" | "block" | "audit_only";

export type InterceptParamMatcher = {
  /** Dot-notation field path, e.g. "command" or "data.token" */
  field: string;
  contains?: string;
  /** Regex pattern string (not compiled until needed) */
  matches?: string;
};

export type InterceptRule = {
  id: string;
  description?: string;
  match: {
    /** Tool name exact match list */
    tools?: string[];
    /** Tool name regex pattern */
    toolPattern?: string;
    params?: InterceptParamMatcher[];
    agentIds?: string[];
    channels?: string[];
  };
  action: InterceptAction;
  /** Message returned to the LLM when blocked */
  blockMessage?: string;
};

export type InterceptDecision =
  | { action: "allow" }
  | { action: "audit_only" }
  | { action: "block"; reason: string; ruleId: string; blockMessage: string };
