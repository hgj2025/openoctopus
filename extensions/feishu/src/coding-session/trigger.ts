/**
 * Detect /code triggers in Feishu messages and start coding sessions.
 *
 * Trigger syntax:
 *   /code <task description>                 — prompts for workdir
 *   /code [workdir:/path/to/project] <task>  — explicit workdir, starts immediately
 *
 * When workdir is not explicit, a confirmation flow is started:
 *   1. Path detected in text (~/foo) → ask user to confirm
 *   2. Partial name detected (tavern) → fuzzy-search + ask user to choose
 *   3. No path at all → show last 5 dirs or ask for input
 *
 * Returns true if the message was handled as a coding session trigger.
 */

import { getSession, resolveProvider, routeFollowUp, startCodingSession } from "@openclaw/coding-session";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import {
  expandPath,
  extractWorkdirHint,
  searchPartialPath,
  displayPath,
} from "./dir-resolver.js";
import { dispatchFollowUp, FeishuChannelAdapter } from "./feishu-adapter.js";
import { addRecentDir, getRecentDirs } from "./recent-dirs.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TriggerContext = {
  cfg: ClawdbotConfig;
  chatId: string;
  threadId?: string;
  messageId: string;
  senderId: string;
  text: string;
  accountId?: string;
  preferredProvider?: string;
};

/** Pending directory selection — waiting for the user to reply with a choice */
interface PendingDirSelection {
  chatId: string;
  threadId?: string;
  messageId: string;
  task: string;
  accountId?: string;
  cfg: ClawdbotConfig;
  preferredProvider?: string;
  /** Numbered candidate dirs displayed to the user. Index 0 → "1". */
  candidates: string[];
  expiresAt: number;
}

// ── Pending state ─────────────────────────────────────────────────────────────

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingDirs = new Map<string, PendingDirSelection>();

function pendingKey(chatId: string, threadId?: string): string {
  return `${chatId}:${threadId ?? "main"}`;
}

function setPending(ctx: TriggerContext, task: string, candidates: string[]): void {
  pendingDirs.set(pendingKey(ctx.chatId, ctx.threadId), {
    chatId: ctx.chatId,
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    task,
    accountId: ctx.accountId,
    cfg: ctx.cfg,
    preferredProvider: ctx.preferredProvider,
    candidates,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

function getPending(chatId: string, threadId?: string): PendingDirSelection | undefined {
  const key = pendingKey(chatId, threadId);
  const p = pendingDirs.get(key);
  if (!p) return undefined;
  if (p.expiresAt < Date.now()) {
    pendingDirs.delete(key);
    return undefined;
  }
  return p;
}

function removePending(chatId: string, threadId?: string): void {
  pendingDirs.delete(pendingKey(chatId, threadId));
}

// ── Logger ────────────────────────────────────────────────────────────────────

function csLog(level: "info" | "warn" | "error", msg: string): void {
  const ts = new Date().toISOString();
  const out = `[${ts}] [coding-session] ${msg}`;
  if (level === "error") console.error(out);
  else console.log(out);
}

// ── Send helper ───────────────────────────────────────────────────────────────

/** Send a plain text message to the chat using a temporary adapter */
async function sendText(ctx: TriggerContext, text: string): Promise<void> {
  const adapter = new FeishuChannelAdapter(
    ctx.cfg,
    ctx.chatId,
    ctx.threadId,
    ctx.messageId,
    ctx.accountId,
    `cs_tmp_${Date.now()}`,
  );
  await adapter.sendText(text).catch((e: unknown) =>
    csLog("error", `failed to send text: ${String(e)}`),
  );
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildSelectionPrompt(task: string, candidates: string[], detected?: string): string {
  const lines: string[] = ["🗂️ 请确认工作目录", ""];

  if (detected) {
    lines.push(`检测到目录：\`${detected}\``);
    if (candidates.length === 1) {
      lines.push("");
      lines.push("回复 `确认` 或 `1` 开始，输入其他路径切换目录，`取消` 中止。");
    } else {
      lines.push("或从以下目录选择：");
      candidates.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
      lines.push("");
      lines.push("回复数字选择，或直接输入目录路径。`取消` 中止。");
    }
  } else if (candidates.length > 0) {
    lines.push("近期使用的目录：");
    candidates.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
    lines.push("");
    lines.push("回复数字选择，或直接输入目录路径（如 `~/myproject`）。`取消` 中止。");
  } else {
    lines.push(`任务：${task.slice(0, 60)}${task.length > 60 ? "…" : ""}`);
    lines.push("");
    lines.push("请输入项目目录路径（如 `~/myproject` 或 `/abs/path`）。`取消` 中止。");
  }

  return lines.join("\n");
}

// ── Main entry point ──────────────────────────────────────────────────────────

const TRIGGER_RE = /^\/code\s+/i;

/**
 * Check if the message is a /code trigger or a follow-up to an active/pending session.
 * Returns true if the message was fully handled.
 */
export async function handleCodingSessionMessage(ctx: TriggerContext): Promise<boolean> {
  const { chatId, threadId, text } = ctx;

  // 0. Pending dir selection has priority over everything else
  const pending = getPending(chatId, threadId);
  if (pending && !TRIGGER_RE.test(text)) {
    return handlePendingReply(pending, ctx);
  }

  // 1. Not a /code trigger — check for follow-up to an active coding session
  if (!TRIGGER_RE.test(text)) {
    const consumed = await routeFollowUp(chatId, threadId, text);
    if (consumed) return true;

    const active = getSession(chatId, threadId);
    if (active) {
      dispatchFollowUp(chatId, threadId, text);
      return true;
    }
    return false;
  }

  // 2. /code trigger — parse workdir hint
  const body = text.replace(TRIGGER_RE, "").trim();
  const { hint, cleanBody } = extractWorkdirHint(body);
  const task = cleanBody.trim();

  if (!task) return false; // empty task — let normal agent handle

  if (hint.type === "explicit") {
    // [workdir:/path] — start immediately, no confirmation needed
    csLog("info", `explicit workdir=${hint.path} task=${task.slice(0, 60)}`);
    await launchSession(ctx, hint.path, task);
    return true;
  }

  if (hint.type === "full") {
    // ~/path or /abs/path detected — confirm before starting
    const candidates = [displayPath(hint.path)];
    await sendText(ctx, buildSelectionPrompt(task, candidates, candidates[0]));
    setPending(ctx, task, candidates);
    return true;
  }

  if (hint.type === "partial") {
    // Bare name (e.g. "tavern") — fuzzy-search for matching dirs
    const found = searchPartialPath(hint.name);
    if (found.length === 0) {
      // Search found nothing — fall through to generic prompt
      const recent = await getRecentDirs();
      await sendText(ctx, buildSelectionPrompt(task, recent));
      setPending(ctx, task, recent);
    } else if (found.length === 1) {
      await sendText(ctx, buildSelectionPrompt(task, found, found[0]));
      setPending(ctx, task, found);
    } else {
      await sendText(ctx, buildSelectionPrompt(task, found, found[0]));
      setPending(ctx, task, found);
    }
    return true;
  }

  // hint.type === "none" — no path hint at all
  const recent = await getRecentDirs();
  await sendText(ctx, buildSelectionPrompt(task, recent));
  setPending(ctx, task, recent);
  return true;
}

// ── Pending reply handler ─────────────────────────────────────────────────────

async function handlePendingReply(
  pending: PendingDirSelection,
  ctx: TriggerContext,
): Promise<boolean> {
  const trimmed = ctx.text.trim();

  // Cancel
  if (/^(取消|cancel|no|n|算了|不了|放弃)$/i.test(trimmed)) {
    removePending(pending.chatId, pending.threadId);
    await sendText(ctx, "❌ 已取消。");
    return true;
  }

  // Numeric selection
  const num = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : 0;
  if (num >= 1 && num <= pending.candidates.length) {
    const workdir = expandPath(pending.candidates[num - 1]!);
    removePending(pending.chatId, pending.threadId);
    await launchSession(ctx, workdir, pending.task);
    return true;
  }

  // "yes / confirm" shortcuts when there's exactly one candidate
  if (/^(是|确认|yes|y|ok|好|开始)$/i.test(trimmed) && pending.candidates.length >= 1) {
    const workdir = expandPath(pending.candidates[0]!);
    removePending(pending.chatId, pending.threadId);
    await launchSession(ctx, workdir, pending.task);
    return true;
  }

  // Full path input (~/foo or /abs/foo)
  if (trimmed.startsWith("~") || trimmed.startsWith("/")) {
    const workdir = expandPath(trimmed.replace(/\/$/, ""));
    removePending(pending.chatId, pending.threadId);
    await launchSession(ctx, workdir, pending.task);
    return true;
  }

  // Partial name — try fuzzy search again
  const found = searchPartialPath(trimmed);
  if (found.length > 0) {
    // Update candidates and re-prompt
    const updatedPending = { ...pending, candidates: found, expiresAt: Date.now() + PENDING_TTL_MS };
    pendingDirs.set(pendingKey(pending.chatId, pending.threadId), updatedPending);
    await sendText(ctx, buildSelectionPrompt(pending.task, found, found[0]));
    return true;
  }

  // Unrecognized — prompt again
  const hint =
    pending.candidates.length > 0
      ? `回复数字（1–${pending.candidates.length}）选择，或输入完整路径（~/path），\`取消\` 中止。`
      : `请输入完整路径（如 \`~/myproject\`），或 \`取消\` 中止。`;
  await sendText(ctx, `❓ 未识别的输入。${hint}`);
  return true;
}

// ── Session launcher ──────────────────────────────────────────────────────────

async function launchSession(ctx: TriggerContext, workdir: string, task: string): Promise<void> {
  const { cfg, chatId, threadId, messageId, accountId, preferredProvider } = ctx;

  let provider;
  try {
    provider = resolveProvider(preferredProvider);
  } catch (err) {
    const sessionId = `cs_err_${Date.now()}`;
    const adapter = new FeishuChannelAdapter(cfg, chatId, threadId, messageId, accountId, sessionId);
    await adapter.sendText(`❌ ${String(err)}`);
    return;
  }

  const sessionId = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const adapter = new FeishuChannelAdapter(cfg, chatId, threadId, messageId, accountId, sessionId);

  csLog("info", `starting session workdir=${workdir} task=${task.slice(0, 60)}`);

  // Save to recent dirs (non-blocking)
  addRecentDir(workdir).catch((e: unknown) =>
    csLog("error", `failed to save recent dir: ${String(e)}`),
  );

  await startCodingSession({
    chatId,
    threadId,
    task,
    workdir,
    provider,
    channel: adapter,
    log: csLog,
  });
}
