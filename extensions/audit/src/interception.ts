import type { AuditCommandPolicyConfig } from "./config-schema.js";
import type { InterceptDecision, InterceptParamMatcher, InterceptRule } from "./types.js";

// ============================================================
// Built-in enterprise baseline rules
// ============================================================

const DEFAULT_ENTERPRISE_RULES: InterceptRule[] = [
  // Block AI-driven permission removal (irreversible, high blast radius)
  {
    id: "perm-remove-guard",
    description: "Block AI-initiated permission member removal",
    match: {
      tools: ["feishu_perm"],
      params: [{ field: "action", contains: "remove" }],
    },
    action: "block",
    blockMessage:
      "Permission removal must be performed manually in the Feishu admin console. The AI agent cannot execute this operation.",
  },
  // Block direct pushes to protected branches
  {
    id: "no-git-push-main",
    description: "Block AI from pushing directly to main/master branches",
    match: {
      tools: ["bash"],
      params: [{ field: "command", matches: String.raw`git\s+push\b.*\b(main|master)\b` }],
    },
    action: "block",
    blockMessage:
      "Direct pushes to the main branch are not allowed. Please create a pull request instead.",
  },
  // Audit-only: all feishu_doc write operations
  {
    id: "doc-write-audit",
    description: "Audit all document write operations",
    match: {
      tools: ["feishu_doc"],
      params: [{ field: "action", matches: String.raw`^(create|update|delete|insert)` }],
    },
    action: "audit_only",
  },
  // Audit-only: bitable write operations
  {
    id: "bitable-write-audit",
    description: "Audit all Bitable record mutations",
    match: {
      tools: ["feishu_bitable"],
      params: [{ field: "action", matches: String.raw`^(create|update|delete|batch)` }],
    },
    action: "audit_only",
  },
];

// ============================================================
// Helpers
// ============================================================

/** Safely retrieve a nested value by dot-notation path */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchesParamMatcher(
  params: Record<string, unknown>,
  matcher: InterceptParamMatcher,
): boolean {
  const value = getNestedValue(params, matcher.field);
  const str = typeof value === "string" ? value : JSON.stringify(value ?? "");

  if (matcher.contains !== undefined && !str.includes(matcher.contains)) {
    return false;
  }
  if (matcher.matches !== undefined) {
    try {
      const re = new RegExp(matcher.matches, "i");
      if (!re.test(str)) {
        return false;
      }
    } catch {
      // Invalid regex in rule — treat as no match (fail open for audit_only, fail closed for block)
      return false;
    }
  }
  return true;
}

function ruleApplies(
  rule: InterceptRule,
  toolName: string,
  params: Record<string, unknown>,
  agentId: string | undefined,
  channel: string | undefined,
): boolean {
  const { match } = rule;

  // Tool name check
  if (match.tools?.length && !match.tools.includes(toolName)) {
    return false;
  }
  if (match.toolPattern) {
    try {
      const re = new RegExp(match.toolPattern, "i");
      if (!re.test(toolName)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  // Agent/channel scope check
  if (match.agentIds?.length && agentId && !match.agentIds.includes(agentId)) {
    return false;
  }
  if (match.channels?.length && channel && !match.channels.includes(channel)) {
    return false;
  }

  // Param matchers (all must match = AND logic)
  if (match.params?.length) {
    for (const matcher of match.params) {
      if (!matchesParamMatcher(params, matcher)) {
        return false;
      }
    }
  }

  return true;
}

// ============================================================
// Command extraction helper
// ============================================================

/**
 * Extract the base command name from a shell command string.
 * Strips leading env-var assignments (KEY=val), sudo (with flags), and path prefixes.
 *
 * Examples:
 *   "git status"           → "git"
 *   "KEY=val node app.js"  → "node"
 *   "sudo -n rm -rf /tmp"  → "rm"
 *   "/usr/bin/git push"    → "git"
 */
export function extractBaseCommand(shellCommand: string): string {
  const tokens = shellCommand.trim().split(/\s+/);
  let i = 0;

  // Skip leading KEY=VALUE env-var tokens
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
    i++;
  }

  // Skip sudo and its option flags (-u user, -n, -E, etc.)
  if (i < tokens.length && tokens[i] === "sudo") {
    i++;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok === "-n" || tok === "-E" || tok === "-S" || tok === "-i" || tok === "-s") {
        i++;
      } else if (tok === "-u" || tok === "-g") {
        // consume the argument following -u/-g
        i += 2;
      } else if (/^-/.test(tok)) {
        i++;
      } else {
        break;
      }
    }
  }

  const cmd = tokens[i] ?? "";
  // Strip path prefix: /usr/bin/git → git
  const slash = cmd.lastIndexOf("/");
  return slash >= 0 ? cmd.slice(slash + 1) : cmd;
}

// ============================================================
// Engine
// ============================================================

export type InterceptionEngineOptions = {
  useDefaultRules?: boolean;
  customRules?: InterceptRule[];
  commandPolicy?: AuditCommandPolicyConfig;
};

export class InterceptionEngine {
  private readonly rules: InterceptRule[];
  private readonly commandPolicy: AuditCommandPolicyConfig | undefined;

  constructor(opts: InterceptionEngineOptions = {}) {
    const defaults = opts.useDefaultRules !== false ? DEFAULT_ENTERPRISE_RULES : [];
    this.rules = [...defaults, ...(opts.customRules ?? [])];
    this.commandPolicy = opts.commandPolicy;
  }

  private evaluateCommandPolicy(shellCommand: string): InterceptDecision | null {
    const policy = this.commandPolicy;
    if (!policy || !policy.enabled || policy.mode === "audit_only") {
      return null;
    }

    const base = extractBaseCommand(shellCommand);

    if (policy.mode === "whitelist") {
      const allowed = policy.allowedCommands ?? [];
      if (!allowed.includes(base)) {
        return {
          action: "block",
          reason: `Command "${base}" is not in the allowed command list`,
          ruleId: "command-policy-whitelist",
          blockMessage:
            policy.blockMessage ??
            `Command "${base}" is not permitted by the command whitelist policy.`,
        };
      }
    } else if (policy.mode === "blacklist") {
      const blocked = policy.blockedCommands ?? [];
      if (blocked.includes(base)) {
        return {
          action: "block",
          reason: `Command "${base}" is blocked by the command blacklist policy`,
          ruleId: "command-policy-blacklist",
          blockMessage:
            policy.blockMessage ??
            `Command "${base}" is not permitted by the command blacklist policy.`,
        };
      }
    }

    return null;
  }

  evaluate(params: {
    toolName: string;
    params: Record<string, unknown>;
    agentId?: string;
    channel?: string;
    sessionKey?: string;
  }): InterceptDecision {
    const { toolName, params: toolParams, agentId, channel } = params;

    // Check command policy first for bash tool calls
    if (
      toolName === "bash" &&
      typeof toolParams.command === "string" &&
      this.commandPolicy?.enabled
    ) {
      const policyDecision = this.evaluateCommandPolicy(toolParams.command);
      if (policyDecision) {
        return policyDecision;
      }
    }

    for (const rule of this.rules) {
      if (!ruleApplies(rule, toolName, toolParams, agentId, channel)) {
        continue;
      }
      if (rule.action === "block") {
        return {
          action: "block",
          reason: rule.description ?? `Blocked by rule: ${rule.id}`,
          ruleId: rule.id,
          blockMessage:
            rule.blockMessage ??
            `This tool call was blocked by enterprise policy (rule: ${rule.id}).`,
        };
      }
      if (rule.action === "audit_only") {
        return { action: "audit_only" };
      }
      // action === "allow": explicit allow, stop evaluating
      return { action: "allow" };
    }

    return { action: "allow" };
  }

  getRules(): readonly InterceptRule[] {
    return this.rules;
  }
}
