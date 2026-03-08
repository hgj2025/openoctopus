import type { GatewayBrowserClient } from "../gateway.ts";

export type AuditEntry = {
  raw: string;
  kind?: string;
  ts?: number;
  isoTime?: string;
  agentId?: string;
  userId?: string;
  sessionId?: string;
  toolName?: string;
  skillName?: string;
  summary?: string;
  /** Actual message content (user.message), or null if capture disabled */
  content?: string | null;
  /** Full tool params JSON string (tool.call / tool.blocked) */
  paramsJson?: string;
};

export type AuditLogsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  auditLoading: boolean;
  auditError: string | null;
  auditDate: string;
  auditDates: string[];
  auditFile: string | null;
  auditEntries: AuditEntry[];
  auditCursor: number | null;
  auditTruncated: boolean;
};

const AUDIT_BUFFER_LIMIT = 2000;

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function buildToolCallHint(obj: Record<string, unknown>): string {
  const toolName = String(obj.toolName ?? "");
  const params = obj.params && typeof obj.params === "object" ? (obj.params as Record<string, unknown>) : null;
  if (!params) return toolName;
  // For bash/shell tools show the command snippet
  if (typeof params.command === "string") {
    return `${toolName}: ${truncate(params.command.trim().replace(/\s+/g, " "), 120)}`;
  }
  // For file tools show the path
  if (typeof params.file_path === "string") {
    return `${toolName}: ${truncate(params.file_path, 120)}`;
  }
  if (typeof params.path === "string") {
    return `${toolName}: ${truncate(params.path, 120)}`;
  }
  // For search tools show the pattern/query
  if (typeof params.pattern === "string") {
    return `${toolName}: ${truncate(params.pattern, 120)}`;
  }
  if (typeof params.query === "string") {
    return `${toolName}: ${truncate(params.query, 120)}`;
  }
  // Generic: show first string param value
  for (const val of Object.values(params)) {
    if (typeof val === "string" && val.length > 0) {
      return `${toolName}: ${truncate(val.trim(), 120)}`;
    }
  }
  return toolName;
}

function buildSummary(obj: Record<string, unknown>): string {
  const kind = String(obj.kind ?? "");
  switch (kind) {
    case "user.message": {
      const channel = typeof obj.channel === "string" ? ` [${obj.channel}]` : "";
      if (typeof obj.content === "string" && obj.content.length > 0) {
        return truncate(obj.content.trim().replace(/\s+/g, " "), 200) + channel;
      }
      const len = obj.contentLength ?? 0;
      return `${len} chars${channel}`;
    }
    case "tool.call":
      return buildToolCallHint(obj);
    case "tool.blocked": {
      const hint = buildToolCallHint(obj);
      const reason = typeof obj.blockReason === "string" ? ` — ${obj.blockReason}` : "";
      return `${hint}${reason}`;
    }
    case "tool.result": {
      const toolName = String(obj.toolName ?? "");
      const ms = typeof obj.durationMs === "number" ? ` ${obj.durationMs}ms` : "";
      if (!obj.success) {
        const err = typeof obj.error === "string" ? truncate(obj.error, 60) : "error";
        return `${toolName} [error: ${err}]${ms}`;
      }
      const size = typeof obj.resultLength === "number" ? ` ${obj.resultLength}b` : "";
      return `${toolName} [ok${size}]${ms}`;
    }
    case "llm.request": {
      const model = String(obj.model ?? obj.provider ?? "");
      const history = typeof obj.historyCount === "number" ? ` | ${obj.historyCount} msgs` : "";
      const prompt = typeof obj.promptLength === "number" ? `, ${obj.promptLength} chars` : "";
      return `${model}${history}${prompt}`;
    }
    case "llm.response": {
      const model = String(obj.model ?? "");
      const ms = typeof obj.durationMs === "number" ? ` ${obj.durationMs}ms` : "";
      const usage = obj.usage && typeof obj.usage === "object" ? (obj.usage as Record<string, unknown>) : null;
      const tokens = usage
        ? ` | in:${usage.inputTokens ?? usage.input_tokens ?? "?"} out:${usage.outputTokens ?? usage.output_tokens ?? "?"}`
        : "";
      return `${model}${ms}${tokens}`;
    }
    case "session.start": {
      const id = String(obj.sessionId ?? "").slice(0, 8);
      const resumed = obj.resumedFrom ? " (resumed)" : "";
      return `session ${id}${resumed}`;
    }
    case "session.end": {
      const id = String(obj.sessionId ?? "").slice(0, 8);
      const msgs = typeof obj.messageCount === "number" ? ` ${obj.messageCount} msgs` : "";
      const ms = typeof obj.durationMs === "number" ? ` ${Math.round(obj.durationMs / 1000)}s` : "";
      return `session ${id}${msgs}${ms}`;
    }
    case "skill.install": {
      const phase = String(obj.phase ?? "");
      const blocked = obj.blocked ? " [BLOCKED]" : "";
      const ok = phase === "after" ? (obj.ok ? " ok" : " failed") : "";
      const warnings = Array.isArray(obj.warnings) && obj.warnings.length > 0 ? ` ${obj.warnings.length} warnings` : "";
      return `${String(obj.skillName ?? "")} ${phase}${ok}${blocked}${warnings}`;
    }
    case "access.denied":
      return String(obj.reason ?? "");
    default:
      return kind;
  }
}

function parseAuditLine(line: string): AuditEntry {
  if (!line.trim()) return { raw: line };
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const params =
      obj.params && typeof obj.params === "object" ? (obj.params as Record<string, unknown>) : null;
    return {
      raw: line,
      kind: typeof obj.kind === "string" ? obj.kind : undefined,
      ts: typeof obj.ts === "number" ? obj.ts : undefined,
      isoTime: typeof obj.isoTime === "string" ? obj.isoTime : undefined,
      agentId: typeof obj.agentId === "string" ? obj.agentId : undefined,
      userId: typeof obj.userId === "string" ? obj.userId : undefined,
      sessionId: typeof obj.sessionId === "string" ? obj.sessionId : undefined,
      toolName: typeof obj.toolName === "string" ? obj.toolName : undefined,
      skillName: typeof obj.skillName === "string" ? obj.skillName : undefined,
      summary: buildSummary(obj),
      content: typeof obj.content === "string" ? obj.content : obj.content === null ? null : undefined,
      paramsJson: params ? JSON.stringify(params, null, 2) : undefined,
    };
  } catch {
    return { raw: line };
  }
}

export async function loadAuditLogs(
  state: AuditLogsState,
  opts?: { reset?: boolean; quiet?: boolean; date?: string },
) {
  if (!state.client || !state.connected) return;
  if (state.auditLoading && !opts?.quiet) return;

  const date = opts?.date ?? state.auditDate;
  const isDateChange = date !== state.auditDate;
  if (isDateChange) {
    state.auditDate = date;
  }

  if (!opts?.quiet) state.auditLoading = true;
  state.auditError = null;

  try {
    const res = await state.client.request("audit.tail", {
      date,
      cursor: opts?.reset || isDateChange ? undefined : (state.auditCursor ?? undefined),
      limit: 500,
      maxBytes: 500_000,
    });
    const payload = res as {
      file?: string;
      date?: string;
      availableDates?: string[];
      cursor?: number;
      lines?: unknown;
      truncated?: boolean;
      reset?: boolean;
    };

    const lines = Array.isArray(payload.lines)
      ? payload.lines.filter((l): l is string => typeof l === "string")
      : [];
    const entries = lines.map(parseAuditLine);
    const shouldReset = Boolean(opts?.reset || isDateChange || payload.reset || state.auditCursor == null);

    state.auditEntries = shouldReset
      ? entries
      : [...state.auditEntries, ...entries].slice(-AUDIT_BUFFER_LIMIT);

    if (typeof payload.cursor === "number") state.auditCursor = payload.cursor;
    if (typeof payload.file === "string") state.auditFile = payload.file;
    if (Array.isArray(payload.availableDates)) {
      state.auditDates = payload.availableDates as string[];
      // Ensure current date is in list even if it has no file yet
      if (date && !state.auditDates.includes(date)) {
        state.auditDates = [date, ...state.auditDates];
      }
    }
    state.auditTruncated = Boolean(payload.truncated);
  } catch (err) {
    state.auditError = String(err);
  } finally {
    if (!opts?.quiet) state.auditLoading = false;
  }
}
