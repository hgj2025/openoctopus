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

function buildSummary(obj: Record<string, unknown>): string {
  const kind = String(obj.kind ?? "");
  switch (kind) {
    case "user.message": {
      const len = obj.contentLength ?? 0;
      const uid = typeof obj.userId === "string" ? ` from ${obj.userId}` : "";
      return `${len} chars${uid}`;
    }
    case "tool.call":
      return String(obj.toolName ?? "");
    case "tool.blocked": {
      const reason = typeof obj.blockReason === "string" ? ` — ${obj.blockReason}` : "";
      return `${String(obj.toolName ?? "")}${reason}`;
    }
    case "tool.result": {
      const ok = obj.success ? "ok" : `error: ${String(obj.error ?? "")}`;
      return `${String(obj.toolName ?? "")} [${ok}]`;
    }
    case "llm.request":
      return `${String(obj.provider ?? "")}/${String(obj.model ?? "")}`;
    case "llm.response": {
      const ms = typeof obj.durationMs === "number" ? ` ${obj.durationMs}ms` : "";
      return `${String(obj.model ?? "")}${ms}`;
    }
    case "session.start":
      return `session ${String(obj.sessionId ?? "").slice(0, 8)}`;
    case "session.end": {
      const msgs = typeof obj.messageCount === "number" ? ` ${obj.messageCount} msgs` : "";
      return `session ${String(obj.sessionId ?? "").slice(0, 8)}${msgs}`;
    }
    case "skill.install": {
      const phase = String(obj.phase ?? "");
      const blocked = obj.blocked ? " [BLOCKED]" : "";
      const ok = phase === "after" ? (obj.ok ? " ok" : " failed") : "";
      return `${String(obj.skillName ?? "")} ${phase}${ok}${blocked}`;
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
