/**
 * Feishu implementation of ChannelAdapter.
 *
 * Output is streamed via FeishuStreamingSession (CardKit API, 100ms throttle).
 * Approval requests get a separate interactive card with Approve/Reject buttons.
 * Regular im.message.patch is NOT used for progress updates — too rate-limited.
 */

import type { ChannelAdapter, SessionCardState } from "@openclaw/coding-session";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "../accounts.js";
import { createFeishuClient } from "../client.js";
import { sendCardFeishu } from "../send.js";
import { FeishuStreamingSession } from "../streaming-card.js";
import { subscribeApproval } from "./approval-bus.js";
import { renderApprovalCard } from "./card-renderer.js";

/** Follow-up message handlers keyed by context key */
const followUpHandlers = new Map<string, Array<(msg: string) => void>>();

function ctxKey(chatId: string, threadId?: string): string {
  return `${chatId}:${threadId ?? "main"}`;
}

/** Called from bot.ts when a message arrives in a session context */
export function dispatchFollowUp(
  chatId: string,
  threadId: string | undefined,
  message: string,
): void {
  const list = followUpHandlers.get(ctxKey(chatId, threadId));
  if (list) {
    for (const h of list) h(message);
  }
}

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly supportsCardUpdate = true;
  readonly supportsInteractiveButtons = true;
  readonly supportsThreading = true;

  private streaming: FeishuStreamingSession | null = null;
  private approvalCardId: string | null = null;

  constructor(
    private readonly cfg: ClawdbotConfig,
    private readonly chatId: string,
    private readonly threadId: string | undefined,
    private readonly replyToMessageId: string | undefined,
    private readonly accountId: string | undefined,
    private readonly sessionId: string,
  ) {}

  async createSessionCard(state: SessionCardState): Promise<string> {
    const account = resolveFeishuAccount({ cfg: this.cfg, accountId: this.accountId });
    const client = createFeishuClient(account);
    const creds = {
      appId: account.appId!,
      appSecret: account.appSecret!,
      domain: account.domain,
    };

    this.streaming = new FeishuStreamingSession(client, creds);

    const receiveId = this.chatId;
    const receiveIdType = this.chatId.startsWith("oc_") ? "chat_id" : "open_id";

    await this.streaming.start(receiveId, receiveIdType, {
      replyToMessageId: this.replyToMessageId,
      replyInThread: this.threadId !== undefined,
      header: {
        title: `⚡ ${state.providerName} · ${truncatePath(state.workdir)}`,
        template: "blue",
      },
    });

    return this.streaming.getMessageId() ?? "unknown";
  }

  async updateSessionCard(_cardId: string, state: SessionCardState): Promise<void> {
    if (!this.streaming) return;

    if (state.status === "awaiting_approval" && state.approval) {
      // Update stream to show we're waiting
      await this.streaming.update(buildStreamText(state));

      // Send a separate interactive card for the approve/reject buttons
      const approvalCard = renderApprovalCard(state.approval.toolRequest, this.sessionId);
      const target = this.chatId.startsWith("oc_") ? `chat:${this.chatId}` : `user:${this.chatId}`;
      try {
        const result = await sendCardFeishu({
          cfg: this.cfg,
          to: target,
          card: approvalCard,
          accountId: this.accountId,
        });
        this.approvalCardId = result.messageId;
      } catch (err) {
        console.error(`[coding-session] failed to send approval card: ${String(err)}`);
      }
      return;
    }

    if (state.status === "done" || state.status === "error") {
      const finalText = buildStreamText(state);
      await this.streaming.close(finalText);
      this.streaming = null;
      return;
    }

    // Normal progress update — streaming session handles throttling internally
    await this.streaming.update(buildStreamText(state));
  }

  onApprovalResponse(_cardId: string, handler: (approved: boolean) => void): () => void {
    // Route by sessionId embedded in the button action value
    return subscribeApproval(this.sessionId, handler);
  }

  onFollowUpMessage(handler: (message: string) => void): () => void {
    const key = ctxKey(this.chatId, this.threadId);
    const list = followUpHandlers.get(key) ?? [];
    list.push(handler);
    followUpHandlers.set(key, list);

    return () => {
      const current = followUpHandlers.get(key);
      if (!current) return;
      const idx = current.indexOf(handler);
      if (idx !== -1) current.splice(idx, 1);
      if (current.length === 0) followUpHandlers.delete(key);
    };
  }

  async sendText(text: string): Promise<void> {
    const account = resolveFeishuAccount({ cfg: this.cfg, accountId: this.accountId });
    const client = createFeishuClient(account);
    const receiveId = this.chatId;
    const receiveIdType = this.chatId.startsWith("oc_") ? "chat_id" : "open_id";

    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }
}

// --- helpers ---

function truncatePath(p: string): string {
  const home = process.env.HOME ?? "/home";
  const rel = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  return rel.length > 40 ? `…${rel.slice(-38)}` : rel;
}

/** Build a plain-text representation of session state for the streaming card */
function buildStreamText(state: SessionCardState): string {
  const lines: string[] = [];

  if (state.currentAction) {
    lines.push(`⏳ ${state.currentAction}`);
    lines.push("");
  }

  if (state.progressLog.length > 0) {
    for (const entry of state.progressLog.slice(-15)) {
      const prefix =
        entry.type === "tool_done" ? "✅" : entry.type === "error" ? "⚠️" : "›";
      lines.push(`${prefix} ${entry.text.slice(0, 100)}`);
    }
  }

  if (state.status === "awaiting_approval" && state.approval) {
    lines.push("");
    lines.push(`⚠️ 等待审批: \`${state.approval.toolRequest.name}\``);
    lines.push("_请在下方卡片点击 批准 或 拒绝_");
  }

  if ((state.status === "done" || state.status === "error") && state.summary) {
    lines.push("");
    lines.push(state.status === "done" ? `✅ ${state.summary}` : `❌ ${state.summary}`);
  }

  return lines.join("\n") || "⏳ 启动中…";
}
