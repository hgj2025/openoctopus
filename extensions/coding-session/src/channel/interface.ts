/**
 * Abstraction over IM channel capabilities needed by the coding session manager.
 *
 * Each channel extension (Feishu, Discord, Slack, …) implements this interface.
 * The session manager never imports channel-specific code.
 */

import type { ProgressEvent, ToolRequest } from "../provider/interface.js";

/** Platform-agnostic representation of a session card / message */
export interface SessionCardState {
  status: "running" | "awaiting_approval" | "done" | "error";
  providerName: string;
  workdir: string;
  /** Most recent action description, e.g. "Editing src/auth.ts" */
  currentAction?: string;
  /** Rolling log of completed steps (shown as a checklist) */
  progressLog: ProgressLogEntry[];
  /** Present when status === "awaiting_approval" */
  approval?: {
    toolRequest: ToolRequest;
    /** Unix ms — approval expires after this time */
    expiresAt: number;
  };
  /** Present when status === "done" | "error" */
  summary?: string;
}

export interface ProgressLogEntry {
  type: ProgressEvent["type"];
  text: string;
  toolName?: string;
}

export interface ChannelAdapter {
  // --- Capability flags ---
  /** Can an existing message/card be edited in-place? */
  readonly supportsCardUpdate: boolean;
  /** Does the channel support interactive buttons for approval? */
  readonly supportsInteractiveButtons: boolean;
  /** Does the channel support threading? */
  readonly supportsThreading: boolean;

  // --- Card lifecycle ---
  /** Create the initial session card; returns an opaque cardId */
  createSessionCard(state: SessionCardState): Promise<string>;
  /** Update the card in-place (or send a new message if not supported) */
  updateSessionCard(cardId: string, state: SessionCardState): Promise<void>;

  // --- Approval flow ---
  /**
   * Register a handler for when the user approves or rejects a tool request.
   * Returns an unsubscribe function.
   * For button-capable channels, triggered by button clicks.
   * For text-only channels, triggered by follow-up messages parsed as y/n.
   */
  onApprovalResponse(
    cardId: string,
    handler: (approved: boolean) => void,
  ): () => void;

  // --- Follow-up messages ---
  /**
   * Register a handler for follow-up messages from the user in this session's context.
   * Returns an unsubscribe function.
   */
  onFollowUpMessage(handler: (message: string) => void): () => void;

  /** Send a plain text message (fallback for non-card channels, or out-of-band notices) */
  sendText(text: string): Promise<void>;
}
