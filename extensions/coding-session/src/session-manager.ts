/**
 * Core coding session manager — channel and provider agnostic.
 *
 * One session per (chatId + optional threadId).
 * Sessions are in-memory; they do not survive process restarts.
 */

import type { ChannelAdapter, ProgressLogEntry, SessionCardState } from "./channel/interface.js";
import type { CodingAgentProvider, ProgressEvent, ToolRequest } from "./provider/interface.js";

export interface CodingSession {
  id: string;
  /** Feishu / Discord / etc. chat room */
  chatId: string;
  /** Thread ID if the session is scoped to a thread */
  threadId?: string;
  /** Opaque ID returned by channel.createSessionCard */
  cardId: string;
  provider: CodingAgentProvider;
  channel: ChannelAdapter;
  status: SessionCardState["status"];
  workdir: string;
  providerName: string;
}

/** Sessions keyed by `${chatId}:${threadId ?? "main"}` */
const sessions = new Map<string, CodingSession>();

function sessionKey(chatId: string, threadId?: string): string {
  return `${chatId}:${threadId ?? "main"}`;
}

/** Returns the active session for a chat/thread, if any */
export function getSession(chatId: string, threadId?: string): CodingSession | undefined {
  return sessions.get(sessionKey(chatId, threadId));
}

/** Remove a session from the registry */
export function removeSession(chatId: string, threadId?: string): void {
  sessions.delete(sessionKey(chatId, threadId));
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PROGRESS_LOG = 20;
/** Minimum ms between card update calls (channel-level throttle is secondary) */
const PROGRESS_DEBOUNCE_MS = 500;

/**
 * Start a new coding session.
 * Returns immediately after the card is posted; the agent runs asynchronously.
 */
export async function startCodingSession(options: {
  chatId: string;
  threadId?: string;
  task: string;
  workdir: string;
  provider: CodingAgentProvider;
  channel: ChannelAdapter;
  /** Optional logger for session errors (defaults to console.error) */
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}): Promise<CodingSession> {
  const { chatId, threadId, task, workdir, provider, channel } = options;
  const log = options.log ?? ((_level, msg) => console.error(msg));

  const key = sessionKey(chatId, threadId);
  const existing = sessions.get(key);
  if (existing) {
    // Terminate any existing session in this context before starting a new one
    await existing.provider.terminate();
    sessions.delete(key);
  }

  const id = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Create the initial card
  const initialState: SessionCardState = {
    status: "running",
    providerName: provider.name,
    workdir,
    currentAction: "Starting…",
    progressLog: [],
  };
  const cardId = await channel.createSessionCard(initialState);

  const session: CodingSession = {
    id,
    chatId,
    threadId,
    cardId,
    provider,
    channel,
    status: "running",
    workdir,
    providerName: provider.name,
  };
  sessions.set(key, session);

  // Wire up the provider callbacks
  const progressLog: ProgressLogEntry[] = [];

  // Debounce progress updates — don't hammer the channel API on rapid events
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingState: SessionCardState | null = null;

  function scheduleProgressUpdate(state: SessionCardState): void {
    pendingState = state;
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const s = pendingState;
      pendingState = null;
      if (!s) return;
      channel.updateSessionCard(cardId, s).catch((err: unknown) => {
        log("error", `[coding-session] updateSessionCard failed: ${String(err)}`);
      });
    }, PROGRESS_DEBOUNCE_MS);
  }

  provider.onProgress((event: ProgressEvent) => {
    progressLog.push({ type: event.type, text: event.text, toolName: event.toolName });
    if (progressLog.length > MAX_PROGRESS_LOG) progressLog.shift();

    scheduleProgressUpdate({
      status: "running",
      providerName: provider.name,
      workdir,
      currentAction: buildCurrentAction(event),
      progressLog: [...progressLog],
    });
  });

  if (provider.supportsToolInterception) {
    provider.onToolRequest?.(async (req: ToolRequest): Promise<boolean> => {
      session.status = "awaiting_approval";
      const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;

      await channel.updateSessionCard(cardId, {
        status: "awaiting_approval",
        providerName: provider.name,
        workdir,
        progressLog: [...progressLog],
        approval: { toolRequest: req, expiresAt },
      });

      return new Promise<boolean>((resolve) => {
        let settled = false;

        const unsub = channel.onApprovalResponse(cardId, (approved) => {
          if (settled) return;
          settled = true;
          unsub();
          clearTimeout(timer);
          session.status = "running";
          resolve(approved);
        });

        // Auto-reject on timeout
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          unsub();
          session.status = "running";
          void channel.sendText(`⏰ Tool approval timed out after 5 minutes — rejected: \`${req.name}\``);
          resolve(false);
        }, APPROVAL_TIMEOUT_MS);
      });
    });
  }

  provider.onComplete((result) => {
    session.status = result.success ? "done" : "error";
    sessions.delete(key);
    // Cancel any pending debounced update
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }

    channel.updateSessionCard(cardId, {
      status: session.status,
      providerName: provider.name,
      workdir,
      progressLog: [...progressLog],
      summary: result.summary ?? result.error ?? (result.success ? "完成。" : "失败。"),
    }).catch((err: unknown) => {
      log("error", `[coding-session] final updateSessionCard failed: ${String(err)}`);
    });
  });

  // Kick off the agent asynchronously
  provider.start({ task, workdir }).catch((err: unknown) => {
    session.status = "error";
    sessions.delete(key);
    log("error", `[coding-session] provider.start failed: ${String(err)}`);
    channel.updateSessionCard(cardId, {
      status: "error",
      providerName: provider.name,
      workdir,
      progressLog: [...progressLog],
      summary: `Fatal error: ${String(err)}`,
    }).catch((e: unknown) => {
      log("error", `[coding-session] error card update failed: ${String(e)}`);
    });
  });

  return session;
}

/**
 * Route a follow-up message from the user to an active session.
 * Returns true if the message was consumed by a session.
 */
export async function routeFollowUp(
  chatId: string,
  threadId: string | undefined,
  message: string,
): Promise<boolean> {
  const session = sessions.get(sessionKey(chatId, threadId));
  if (!session) return false;

  if (session.status === "awaiting_approval") {
    // Text-based approval for channels without buttons
    const lower = message.trim().toLowerCase();
    const approved = /^(y|yes|ok|approve|批准|确认)$/i.test(lower);
    const rejected = /^(n|no|reject|cancel|拒绝|取消)$/i.test(lower);
    if (approved || rejected) {
      // The approval-bus / onApprovalResponse subscriber in each channel
      // handles the actual resolution. Emit via the channel's text approval path.
      session.channel.onApprovalResponse(session.cardId, (a) => void a); // no-op ensure bus exists
      return true;
    }
  }

  if (session.provider.supportsFollowUp) {
    await session.provider.sendFollowUp?.(message);
    return true;
  }

  return false;
}

// --- helpers ---

function buildCurrentAction(event: ProgressEvent): string {
  switch (event.type) {
    case "tool_start":
      return `Using \`${event.toolName ?? event.text}\``;
    case "tool_done":
      return `Done: \`${event.toolName ?? event.text}\``;
    case "thinking":
      return "Thinking…";
    case "error":
      return `⚠️ ${event.text}`;
    default:
      return event.text.slice(0, 80);
  }
}
