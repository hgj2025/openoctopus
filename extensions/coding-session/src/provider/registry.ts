/**
 * Provider registry — auto-detects installed coding agents and constructs the right provider.
 *
 * Priority: claude-code > codex > opencode > pi
 * Config or explicit preference overrides auto-detection.
 */

import { execSync } from "node:child_process";
import { AidenCliProvider } from "./aiden-cli.js";
import { ClaudeCodeCliProvider } from "./claude-code-cli.js";
import type { CodingAgentProvider } from "./interface.js";
import { PTYGenericProvider } from "./pty-generic.js";

export type ProviderName = "claude-code" | "aiden" | "codex" | "opencode" | "pi";

/** Priority-ordered list of (providerName, binary, factory) */
const PROVIDERS: Array<{
  name: ProviderName;
  bin: string;
  /** Factory receives the resolved absolute path to the binary */
  factory: (binPath: string) => CodingAgentProvider;
}> = [
  { name: "claude-code", bin: "claude", factory: (p) => new ClaudeCodeCliProvider(p) },
  { name: "aiden", bin: "aiden", factory: (p) => new AidenCliProvider(p) },
  { name: "codex", bin: "codex", factory: (p) => new PTYGenericProvider("codex exec", "codex", p) },
  {
    name: "opencode",
    bin: "opencode",
    factory: (p) => new PTYGenericProvider("opencode run", "opencode", p),
  },
  { name: "pi", bin: "pi", factory: (p) => new PTYGenericProvider("pi", "pi", p) },
];

/** Returns the resolved absolute path if the binary is available, otherwise null */
function resolveBinPath(bin: string): string | null {
  try {
    return execSync(`which ${bin}`, { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
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
    const binPath = resolveBinPath(p.bin);
    if (binPath) {
      return p.factory(binPath);
    }
  }

  const tried = candidates.map((p) => p.bin).join(", ");
  throw new Error(
    `No coding agent available. Tried: ${tried}. ` +
      `Install one of: claude (Claude Code), codex, opencode, pi.`,
  );
}
