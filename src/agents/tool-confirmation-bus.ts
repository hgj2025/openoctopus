/**
 * Tool confirmation bus — channel-agnostic pub/sub for tool execution approval.
 *
 * Flow:
 *   1. tool-confirm extension calls requestConfirmation() with a unique id
 *      → registers a pending promise, returns it
 *   2. Channel adapter (e.g. Feishu card action) calls resolveConfirmation(id, approved)
 *      → resolves the pending promise
 *   3. Timeout auto-resolves if configured (default: approve after 3 min)
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("tool-confirmation-bus");

export type ConfirmationRequest = {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  sessionKey?: string;
  timeoutMs?: number;
  autoApproveOnTimeout?: boolean;
};

type PendingEntry = {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingEntry>();

/**
 * Register a pending confirmation and return a promise that resolves when
 * the user approves/rejects or the timeout expires.
 */
export function requestConfirmation(req: ConfirmationRequest): Promise<boolean> {
  const timeoutMs = req.timeoutMs ?? 180_000;
  const autoApprove = req.autoApproveOnTimeout ?? true;

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(req.id);
      log.warn(
        `confirmation timed out after ${timeoutMs}ms: id=${req.id} tool=${req.toolName} auto=${autoApprove ? "approve" : "reject"}`,
      );
      resolve(autoApprove);
    }, timeoutMs);

    // Prevent timer from keeping the process alive
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    pending.set(req.id, { resolve, timer });
  });
}

/**
 * Resolve a pending confirmation. Called by channel adapters (e.g. Feishu card action).
 * Returns true if a pending confirmation was found and resolved.
 */
export function resolveConfirmation(id: string, approved: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) {
    return false;
  }
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(approved);
  return true;
}

/** Check if there is a pending confirmation for a given id. */
export function hasPendingConfirmation(id: string): boolean {
  return pending.has(id);
}

// =========================================================================
// Confirmation request event bus — channel adapters subscribe to render UI
// =========================================================================

export type ConfirmationRequestEvent = {
  confirmId: string;
  toolName: string;
  params: Record<string, unknown>;
  sessionKey?: string;
  deliveryContext: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
};

type ConfirmationRequestHandler = (event: ConfirmationRequestEvent) => void | Promise<void>;

const requestHandlers: ConfirmationRequestHandler[] = [];

/** Subscribe to confirmation request events (called by channel adapters). */
export function onConfirmationRequest(handler: ConfirmationRequestHandler): () => void {
  requestHandlers.push(handler);
  return () => {
    const idx = requestHandlers.indexOf(handler);
    if (idx !== -1) requestHandlers.splice(idx, 1);
  };
}

/** Emit a confirmation request event for channel adapters to render UI. */
export function emitConfirmationRequest(event: ConfirmationRequestEvent): void {
  for (const handler of requestHandlers) {
    try {
      void handler(event);
    } catch (err) {
      log.warn(`confirmation request handler error: ${String(err)}`);
    }
  }
}

/** Exported for testing. */
export const __testing = { pending, requestHandlers };
