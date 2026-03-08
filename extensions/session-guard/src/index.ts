import type { OpenClawPluginDefinition, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Authorization state ───────────────────────────────────────────────────────
// Keyed by agentId (or "default"). Stores timestamp of last auth grant.
const authGrants = new Map<string, number>();
const AUTH_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ── Command tracking ──────────────────────────────────────────────────────────
// Keyed by agentId. Preserves insertion order; dedup at session end.
const sessionCmds = new Map<string, string[]>();

// ── Constants ─────────────────────────────────────────────────────────────────

// Tools that modify files — require explicit user authorization
const WRITE_TOOLS = new Set(["edit", "write", "notebook_edit"]);

// Keywords in user messages that grant code-modification permission
const AUTH_KEYWORDS = [
  // Chinese
  "帮我改", "帮我写", "帮我实现", "帮我开发", "帮我重构", "帮我优化",
  "修bug", "修 bug", "修复", "修改", "修这个",
  "实现", "开发", "添加功能", "优化代码", "重构代码", "改代码", "写代码",
  // English
  "fix", "implement", "refactor", "create file", "write code",
  "update the code", "modify the", "add the feature",
];

function hasAuthKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

function isAuthorized(agentId: string): boolean {
  // Check agent-specific grant, fall back to "default" (set by message_received)
  const granted = authGrants.get(agentId) ?? authGrants.get("default");
  return granted !== undefined && Date.now() - granted < AUTH_TTL_MS;
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin: OpenClawPluginDefinition = {
  id: "session-guard",
  name: "Session Guard",
  description: "Code modification authorization, command audit, and session summary",

  register(api: OpenClawPluginApi) {
    const log = (msg: string) => api.logger.info(`[session-guard] ${msg}`);

    // ── 1. Detect authorization keywords in incoming user messages ────────────
    // message_received ctx has channelId/conversationId but NOT agentId/sessionKey,
    // so we store under "default" — picked up by all agents within TTL.
    api.on("message_received", (event, _ctx) => {
      if (hasAuthKeyword(event.content)) {
        authGrants.set("default", Date.now());
        log("code modification authorized via user message");
      }
    });

    // ── 2. Intercept file write tools — require authorization ─────────────────
    api.on("before_tool_call", (event, ctx) => {
      const { toolName } = event;

      if (!WRITE_TOOLS.has(toolName)) return;

      const agentId = ctx.agentId ?? "default";
      if (isAuthorized(agentId)) return;

      return {
        block: true,
        blockReason:
          "Code modification is blocked. The user has not authorized code changes in this " +
          "session. Wait for the user to explicitly request code modification " +
          "(e.g., '帮我修这个bug' / 'implement this feature') before using file edit tools.",
      };
    });

    // ── 3. Track bash commands after execution ────────────────────────────────
    api.on("after_tool_call", (event, ctx) => {
      if (event.toolName !== "bash") return;
      const cmd = typeof event.params.command === "string" ? event.params.command.trim() : null;
      if (!cmd) return;

      const key = ctx.agentId ?? "default";
      const cmds = sessionCmds.get(key) ?? [];
      cmds.push(cmd);
      sessionCmds.set(key, cmds);
    });

    // ── 4. Session end: write deduplicated command summary to file ────────────
    api.on("session_end", (event, ctx) => {
      const key = ctx.agentId ?? "default";
      const cmds = sessionCmds.get(key);
      sessionCmds.delete(key);

      if (!cmds || cmds.length === 0) return;

      const unique = dedup(cmds);
      const now = new Date();
      const date = now.toISOString().slice(0, 10);

      const summaryDir = join(homedir(), ".openclaw", "session-summaries");
      mkdirSync(summaryDir, { recursive: true });
      const summaryFile = join(summaryDir, `${date}.txt`);

      const lines = [
        "",
        `=== Session ${event.sessionId}  ended at ${now.toLocaleTimeString()} ===`,
        `Executed commands (${unique.length} unique):`,
        ...unique.map((c) => `  $ ${c}`),
        "",
      ].join("\n");

      appendFileSync(summaryFile, lines, "utf-8");
      log(`session summary written → ${summaryFile}  (${unique.length} commands)`);
    });

    log("plugin active");
  },
};

export default plugin;
