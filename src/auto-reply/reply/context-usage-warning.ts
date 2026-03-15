/**
 * Context usage warning — appends a one-time warning when context utilization
 * exceeds a configurable threshold.
 */

import type { SessionEntry } from "../../config/sessions/types.js";

const DEFAULT_THRESHOLD = 0.8;

/**
 * Check whether a context usage warning should be emitted for this session.
 * Returns true at most once per session (tracked via contextWarningEmitted).
 */
export function shouldWarnContextUsage(
  entry: Pick<SessionEntry, "totalTokens" | "contextTokens" | "contextWarningEmitted">,
  threshold?: number,
): boolean {
  if (entry.contextWarningEmitted) return false;

  const total = entry.totalTokens;
  const context = entry.contextTokens;
  if (typeof total !== "number" || typeof context !== "number") return false;
  if (context <= 0) return false;

  const ratio = total / context;
  return ratio >= (threshold ?? DEFAULT_THRESHOLD);
}

/**
 * Format the context usage warning message.
 */
export function formatContextWarning(
  entry: Pick<SessionEntry, "totalTokens" | "contextTokens">,
): string {
  const total = entry.totalTokens ?? 0;
  const context = entry.contextTokens ?? 1;
  const pct = Math.round((total / context) * 100);
  const usedLabel = formatTokens(total);
  const totalLabel = formatTokens(context);
  return `⚠️ 上下文已用 ${pct}%（${usedLabel}/${totalLabel} tokens），建议 /new 开启新会话`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
