import { getChannelDock } from "../../channels/dock.js";
import { resolveChannelConfigWrites } from "../../channels/plugins/config-writes.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { normalizeChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";
import { rejectUnauthorizedCommand, requireCommandFlagEnabled } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

type AllowlistScope = "dm" | "group" | "all";
type AllowlistAction = "list" | "add" | "remove";

type AllowlistCommand =
  | {
      action: "list";
      scope: AllowlistScope;
      channel?: string;
      account?: string;
    }
  | {
      action: "add" | "remove";
      scope: AllowlistScope;
      channel?: string;
      account?: string;
      entry: string;
    }
  | { action: "error"; message: string };

const ACTIONS = new Set(["list", "add", "remove"]);
const SCOPES = new Set<AllowlistScope>(["dm", "group", "all"]);

function parseAllowlistCommand(raw: string): AllowlistCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("/allowlist")) {
    return null;
  }
  const rest = trimmed.slice("/allowlist".length).trim();
  if (!rest) {
    return { action: "list", scope: "dm" };
  }

  const tokens = rest.split(/\s+/);
  let action: AllowlistAction = "list";
  let scope: AllowlistScope = "dm";
  let channel: string | undefined;
  let account: string | undefined;
  const entryTokens: string[] = [];

  let i = 0;
  if (tokens[i] && ACTIONS.has(tokens[i].toLowerCase())) {
    action = tokens[i].toLowerCase() as AllowlistAction;
    i += 1;
  }
  if (tokens[i] && SCOPES.has(tokens[i].toLowerCase() as AllowlistScope)) {
    scope = tokens[i].toLowerCase() as AllowlistScope;
    i += 1;
  }

  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lowered = token.toLowerCase();
    if (lowered === "--channel" && tokens[i + 1]) {
      channel = tokens[i + 1];
      i += 1;
      continue;
    }
    if (lowered === "--account" && tokens[i + 1]) {
      account = tokens[i + 1];
      i += 1;
      continue;
    }
    const kv = token.split("=");
    if (kv.length === 2) {
      const key = kv[0]?.trim().toLowerCase();
      const value = kv[1]?.trim();
      if (key === "channel") {
        if (value) {
          channel = value;
        }
        continue;
      }
      if (key === "account") {
        if (value) {
          account = value;
        }
        continue;
      }
      if (key === "scope" && value && SCOPES.has(value.toLowerCase() as AllowlistScope)) {
        scope = value.toLowerCase() as AllowlistScope;
        continue;
      }
    }
    entryTokens.push(token);
  }

  if (action === "add" || action === "remove") {
    const entry = entryTokens.join(" ").trim();
    if (!entry) {
      return { action: "error", message: "Usage: /allowlist add|remove <entry>" };
    }
    return { action, scope, entry, channel, account };
  }

  return { action: "list", scope, channel, account };
}

function normalizeAllowFrom(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
  values: Array<string | number>;
}): string[] {
  const dock = getChannelDock(params.channelId);
  if (dock?.config?.formatAllowFrom) {
    return dock.config.formatAllowFrom({
      cfg: params.cfg,
      accountId: params.accountId,
      allowFrom: params.values,
    });
  }
  return params.values.map((entry) => String(entry).trim()).filter(Boolean);
}

function formatEntryList(entries: string[], resolved?: Map<string, string>): string {
  if (entries.length === 0) {
    return "(none)";
  }
  return entries
    .map((entry) => {
      const name = resolved?.get(entry);
      return name ? `${entry} (${name})` : entry;
    })
    .join(", ");
}


function resolveAccountTarget(
  parsed: Record<string, unknown>,
  channelId: ChannelId,
  accountId?: string | null,
) {
  const channels = (parsed.channels ??= {}) as Record<string, unknown>;
  const channel = (channels[channelId] ??= {}) as Record<string, unknown>;
  const normalizedAccountId = normalizeAccountId(accountId);
  if (isBlockedObjectKey(normalizedAccountId)) {
    return { target: channel, pathPrefix: `channels.${channelId}`, accountId: DEFAULT_ACCOUNT_ID };
  }
  const hasAccounts = Boolean(channel.accounts && typeof channel.accounts === "object");
  const useAccount = normalizedAccountId !== DEFAULT_ACCOUNT_ID || hasAccounts;
  if (!useAccount) {
    return { target: channel, pathPrefix: `channels.${channelId}`, accountId: normalizedAccountId };
  }
  const accounts = (channel.accounts ??= {}) as Record<string, unknown>;
  const existingAccount = Object.hasOwn(accounts, normalizedAccountId)
    ? accounts[normalizedAccountId]
    : undefined;
  if (!existingAccount || typeof existingAccount !== "object") {
    accounts[normalizedAccountId] = {};
  }
  const account = accounts[normalizedAccountId] as Record<string, unknown>;
  return {
    target: account,
    pathPrefix: `channels.${channelId}.accounts.${normalizedAccountId}`,
    accountId: normalizedAccountId,
  };
}

function getNestedValue(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function ensureNestedObject(
  root: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  let current = root;
  for (const key of path) {
    const existing = current[key];
    if (!existing || typeof existing !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

function setNestedValue(root: Record<string, unknown>, path: string[], value: unknown) {
  if (path.length === 0) {
    return;
  }
  if (path.length === 1) {
    root[path[0]] = value;
    return;
  }
  const parent = ensureNestedObject(root, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
}

function deleteNestedValue(root: Record<string, unknown>, path: string[]) {
  if (path.length === 0) {
    return;
  }
  if (path.length === 1) {
    delete root[path[0]];
    return;
  }
  const parent = getNestedValue(root, path.slice(0, -1));
  if (!parent || typeof parent !== "object") {
    return;
  }
  delete (parent as Record<string, unknown>)[path[path.length - 1]];
}

function resolveChannelAllowFromPaths(
  channelId: ChannelId,
  scope: AllowlistScope,
): string[] | null {
  if (scope === "all") {
    return null;
  }
  // Determine group allowlist support via channel plugin capabilities
  const dock = getChannelDock(channelId);
  const supportsGroupAllowlist = Boolean(dock?.config?.formatAllowFrom);
  if (scope === "dm") {
    return ["allowFrom"];
  }
  if (scope === "group") {
    if (supportsGroupAllowlist) {
      return ["groupAllowFrom"];
    }
    return null;
  }
  return null;
}



export const handleAllowlistCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseAllowlistCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (parsed.action === "error") {
    return { shouldContinue: false, reply: { text: `⚠️ ${parsed.message}` } };
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/allowlist");
  if (unauthorized) {
    return unauthorized;
  }

  const channelId =
    normalizeChannelId(parsed.channel) ??
    params.command.channelId ??
    normalizeChannelId(params.command.channel);
  if (!channelId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Unknown channel. Add channel=<id> to the command." },
    };
  }
  if (parsed.account?.trim() && !normalizeOptionalAccountId(parsed.account)) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Invalid account id. Reserved keys (__proto__, constructor, prototype) are blocked.",
      },
    };
  }
  const accountId = normalizeAccountId(parsed.account ?? params.ctx.AccountId);
  const scope = parsed.scope;

  if (parsed.action === "list") {
    const lines: string[] = ["🧾 Allowlist"];
    lines.push(`Channel: ${channelId}${accountId ? ` (account ${accountId})` : ""}`);

    // Use channel dock to resolve allowlist entries when available.
    const channelCfg = (params.cfg.channels as Record<string, unknown> | undefined)?.[channelId];
    const channelObj =
      channelCfg && typeof channelCfg === "object"
        ? (channelCfg as Record<string, unknown>)
        : undefined;
    const allowFromRaw = Array.isArray(channelObj?.allowFrom)
      ? (channelObj.allowFrom as Array<string | number>)
      : [];
    const groupAllowFromRaw = Array.isArray(channelObj?.groupAllowFrom)
      ? (channelObj.groupAllowFrom as Array<string | number>)
      : [];

    const showDm = scope === "dm" || scope === "all";
    const showGroup = scope === "group" || scope === "all";

    if (showDm) {
      const dmDisplay = normalizeAllowFrom({
        cfg: params.cfg,
        channelId,
        accountId,
        values: allowFromRaw,
      });
      lines.push(`DM allowFrom (config): ${formatEntryList(dmDisplay)}`);
    }
    if (showGroup && groupAllowFromRaw.length > 0) {
      const groupDisplay = normalizeAllowFrom({
        cfg: params.cfg,
        channelId,
        accountId,
        values: groupAllowFromRaw,
      });
      lines.push(`Group allowFrom (config): ${formatEntryList(groupDisplay)}`);
    }

    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/allowlist edits",
    configKey: "config",
    disabledVerb: "are",
  });
  if (disabled) {
    return disabled;
  }

  const allowWrites = resolveChannelConfigWrites({
    cfg: params.cfg,
    channelId,
    accountId: params.ctx.AccountId,
  });
  if (!allowWrites) {
    const hint = `channels.${channelId}.configWrites=true`;
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Config writes are disabled for ${channelId}. Set ${hint} to enable.` },
    };
  }

  const allowlistPath = resolveChannelAllowFromPaths(channelId, scope);
  if (!allowlistPath) {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ ${channelId} does not support ${scope} allowlist edits via /allowlist.`,
      },
    };
  }

  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Config file is invalid; fix it before using /allowlist." },
    };
  }
  const parsedConfig = structuredClone(snapshot.parsed as Record<string, unknown>);
  const {
    target,
    pathPrefix,
    accountId: normalizedAccountId,
  } = resolveAccountTarget(parsedConfig, channelId, accountId);
  const existing: string[] = [];
  const existingRaw = getNestedValue(target, allowlistPath);
  if (Array.isArray(existingRaw)) {
    for (const entry of existingRaw) {
      const value = String(entry).trim();
      if (!value || existing.includes(value)) {
        continue;
      }
      existing.push(value);
    }
  }

  const normalizedEntry = normalizeAllowFrom({
    cfg: params.cfg,
    channelId,
    accountId: normalizedAccountId,
    values: [parsed.entry],
  });
  if (normalizedEntry.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Invalid allowlist entry." },
    };
  }

  const existingNormalized = normalizeAllowFrom({
    cfg: params.cfg,
    channelId,
    accountId: normalizedAccountId,
    values: existing,
  });

  const shouldMatch = (value: string) => normalizedEntry.includes(value);

  let configChanged = false;
  let next = existing;
  const configHasEntry = existingNormalized.some((value) => shouldMatch(value));
  if (parsed.action === "add") {
    if (!configHasEntry) {
      next = [...existing, parsed.entry.trim()];
      configChanged = true;
    }
  }

  if (parsed.action === "remove") {
    const keep: string[] = [];
    for (const entry of existing) {
      const normalized = normalizeAllowFrom({
        cfg: params.cfg,
        channelId,
        accountId: normalizedAccountId,
        values: [entry],
      });
      if (normalized.some((value) => shouldMatch(value))) {
        configChanged = true;
        continue;
      }
      keep.push(entry);
    }
    next = keep;
  }

  if (configChanged) {
    if (next.length === 0) {
      deleteNestedValue(target, allowlistPath);
    } else {
      setNestedValue(target, allowlistPath, next);
    }
  }

  if (!configChanged) {
    const message = parsed.action === "add" ? "✅ Already allowlisted." : "⚠️ Entry not found.";
    return { shouldContinue: false, reply: { text: message } };
  }

  const validated = validateConfigObjectWithPlugins(parsedConfig);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Config invalid after update (${issue.path}: ${issue.message}).` },
    };
  }
  await writeConfigFile(validated.config);

  const actionLabel = parsed.action === "add" ? "added" : "removed";
  const scopeLabel = scope === "dm" ? "DM" : "group";
  return {
    shouldContinue: false,
    reply: {
      text: `✅ ${scopeLabel} allowlist ${actionLabel}: ${pathPrefix}.${allowlistPath.join(".")}.`,
    },
  };
};
