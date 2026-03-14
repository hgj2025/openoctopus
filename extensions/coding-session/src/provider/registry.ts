/**
 * Provider registry — auto-detects installed coding agents and constructs the right provider.
 *
 * Priority: claude-code > codex > opencode > pi
 * Config or explicit preference overrides auto-detection.
 */

import { execSync } from "node:child_process";
import { ClaudeCodeCliProvider } from "./claude-code-cli.js";
import type { CodingAgentProvider } from "./interface.js";
import { PTYGenericProvider } from "./pty-generic.js";

export type ProviderName = "claude-code" | "codex" | "opencode" | "pi";

/** Priority-ordered list of (providerName, binary, factory) */
const PROVIDERS: Array<{
  name: ProviderName;
  bin: string;
  factory: () => CodingAgentProvider;
}> = [
  { name: "claude-code", bin: "claude", factory: () => new ClaudeCodeCliProvider() },
  { name: "codex", bin: "codex", factory: () => new PTYGenericProvider("codex exec", "codex") },
  {
    name: "opencode",
    bin: "opencode",
    factory: () => new PTYGenericProvider("opencode run", "opencode"),
  },
  { name: "pi", bin: "pi", factory: () => new PTYGenericProvider("pi", "pi") },
];

function isBinAvailable(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a provider by name or auto-detect the first available one.
 * Throws if no coding agent is found on the system.
 */
export function resolveProvider(preference?: ProviderName | string): CodingAgentProvider {
  const candidates = preference
    ? PROVIDERS.filter((p) => p.name === preference || p.bin === preference)
    : PROVIDERS;

  for (const p of candidates) {
    if (isBinAvailable(p.bin)) {
      return p.factory();
    }
  }

  const tried = candidates.map((p) => p.bin).join(", ");
  throw new Error(
    `No coding agent available. Tried: ${tried}. ` +
      `Install one of: claude (Claude Code), codex, opencode, pi.`,
  );
}
