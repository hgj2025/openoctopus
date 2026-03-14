/**
 * Approval bus — decouples card button clicks from pending approval promises.
 *
 * Flow:
 *   1. Session manager calls channel.onApprovalResponse(cardId, handler)
 *      → registers handler here
 *   2. card-action.ts detects a coding_session action and calls resolveApproval(cardId, approved)
 *      → triggers the registered handler
 */

type ApprovalHandler = (approved: boolean) => void;

const handlers = new Map<string, ApprovalHandler[]>();

/** Register an approval handler for a given cardId. Returns an unsubscribe fn. */
export function subscribeApproval(cardId: string, handler: ApprovalHandler): () => void {
  const list = handlers.get(cardId) ?? [];
  list.push(handler);
  handlers.set(cardId, list);

  return () => {
    const current = handlers.get(cardId);
    if (!current) return;
    const idx = current.indexOf(handler);
    if (idx !== -1) current.splice(idx, 1);
    if (current.length === 0) handlers.delete(cardId);
  };
}

/**
 * Resolve all pending approval handlers for a cardId.
 * Called from card-action.ts when a coding_session approve/reject button is clicked.
 */
export function resolveApproval(cardId: string, approved: boolean): boolean {
  const list = handlers.get(cardId);
  if (!list || list.length === 0) return false;
  // Fire all handlers (normally just one) and clear
  for (const h of list) h(approved);
  handlers.delete(cardId);
  return true;
}

/** Check if there are pending handlers for a card (used to skip normal message dispatch) */
export function hasPendingApproval(cardId: string): boolean {
  return (handlers.get(cardId)?.length ?? 0) > 0;
}
