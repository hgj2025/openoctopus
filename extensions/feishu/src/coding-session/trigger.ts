/**
 * Detect /code triggers in Feishu messages and start coding sessions.
 *
 * Trigger syntax:
 *   /code <task description>                 — uses default workdir
 *   /code [workdir:/path/to/project] <task>  — explicit workdir
 *
 * Returns true if the message was handled as a coding session trigger.
 */

import { getSession, resolveProvider, routeFollowUp, startCodingSession } from "@openclaw/coding-session";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { dispatchFollowUp, FeishuChannelAdapter } from "./feishu-adapter.js";

const TRIGGER_RE = /^\/code\s+/i;
const WORKDIR_RE = /\[workdir:([^\]]+)\]/i;

/** Default workdir when user doesn't specify one — expand ~ */
function defaultWorkdir(): string {
  return process.env.HOME ?? process.cwd();
}

export type TriggerContext = {
  cfg: ClawdbotConfig;
  chatId: string;
  threadId?: string;
  messageId: string;
  senderId: string;
  text: string;
  accountId?: string;
  /** Configured preferred provider, if any */
  preferredProvider?: string;
};

/**
 * Check if the message is a /code trigger or a follow-up to an active session.
 * Returns true if the message was fully handled (skip main agent dispatch).
 */
export async function handleCodingSessionMessage(ctx: TriggerContext): Promise<boolean> {
  const { cfg, chatId, threadId, messageId, text, accountId, preferredProvider } = ctx;

  // --- Follow-up to active session ---
  if (!TRIGGER_RE.test(text)) {
    const consumed = await routeFollowUp(chatId, threadId, text);
    if (consumed) return true;

    // Also dispatch to feishu follow-up handlers (for approval text fallback)
    const active = getSession(chatId, threadId);
    if (active) {
      dispatchFollowUp(chatId, threadId, text);
      return true;
    }
    return false;
  }

  // --- New /code trigger ---
  let body = text.replace(TRIGGER_RE, "").trim();

  // Extract optional [workdir:...] annotation
  const wdMatch = WORKDIR_RE.exec(body);
  let workdir = defaultWorkdir();
  if (wdMatch) {
    workdir = wdMatch[1]!.replace(/^~/, process.env.HOME ?? "~");
    body = body.replace(wdMatch[0], "").trim();
  }

  if (!body) {
    // No task provided — ignore (let normal agent handle the /code with no args)
    return false;
  }

  let provider;
  try {
    provider = resolveProvider(preferredProvider);
  } catch (err) {
    const sessionId = `cs_err_${Date.now()}`;
    const adapter = new FeishuChannelAdapter(cfg, chatId, threadId, messageId, accountId, sessionId);
    await adapter.sendText(`❌ ${String(err)}`);
    return true;
  }

  const sessionId = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const adapter = new FeishuChannelAdapter(
    cfg,
    chatId,
    threadId,
    messageId,
    accountId,
    sessionId,
  );

  await startCodingSession({
    chatId,
    threadId,
    task: body,
    workdir,
    provider,
    channel: adapter,
  });

  return true;
}
