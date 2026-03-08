import { z } from "zod";

const InterceptParamMatcherSchema = z.object({
  field: z.string(),
  contains: z.string().optional(),
  matches: z.string().optional(),
});

const InterceptRuleSchema = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    match: z.object({
      tools: z.array(z.string()).optional(),
      toolPattern: z.string().optional(),
      params: z.array(InterceptParamMatcherSchema).optional(),
      agentIds: z.array(z.string()).optional(),
      channels: z.array(z.string()).optional(),
    }),
    action: z.enum(["allow", "block", "audit_only"]),
    blockMessage: z.string().optional(),
  })
  .strict();

// ============================================================
// MCP sink transport schemas
// ============================================================

/**
 * mcporter transport: delegates to `mcporter call <server>.<tool>` CLI.
 * Requires mcporter to be installed and on PATH.
 * Consistent with the existing memory/qmd mcporter integration in the codebase.
 */
const McpTransportMcporterSchema = z
  .object({
    kind: z.literal("mcporter"),
    /** mcporter server name configured in ~/.mcporter/config.json */
    serverName: z.string(),
    /** Auto-start the mcporter daemon before the first call (default: true) */
    startDaemon: z.boolean().default(true),
    /** Per-call timeout passed to mcporter --timeout (ms) */
    timeoutMs: z.number().int().positive().default(10_000),
  })
  .strict();

/**
 * stdio transport: spawns a long-lived MCP server process and communicates
 * via newline-delimited JSON-RPC 2.0 over stdin/stdout (raw MCP protocol).
 * Lower latency than mcporter for high-volume environments.
 */
const McpTransportStdioSchema = z
  .object({
    kind: z.literal("stdio"),
    /** Executable to spawn (e.g. "node", "python3", "/usr/local/bin/audit-mcp") */
    command: z.string(),
    /** Arguments to the command (e.g. ["/path/to/server.js"]) */
    args: z.array(z.string()).optional(),
    /** Extra environment variables for the server process */
    env: z.record(z.string()).optional(),
    /** Timeout for MCP initialize handshake (ms, default: 10_000) */
    initTimeoutMs: z.number().int().positive().default(10_000),
    /** Per tool-call timeout (ms) */
    timeoutMs: z.number().int().positive().default(10_000),
  })
  .strict();

const McpTransportSchema = z.discriminatedUnion("kind", [
  McpTransportMcporterSchema,
  McpTransportStdioSchema,
]);

const McpSinkSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Transport configuration.
     * Use "mcporter" when you have mcporter set up (matches existing codebase pattern).
     * Use "stdio" to connect directly to an MCP server process without mcporter.
     */
    transport: McpTransportSchema,
    /**
     * MCP tool name the remote server exposes for audit log submission.
     * The tool will receive: { events: AuditEvent[], batchTime: string, count: number }
     */
    toolName: z.string().default("submit_audit_log"),
    /** Max retry attempts on transient failure (default: 3) */
    maxRetries: z.number().int().min(0).default(3),
    /** Max events to hold in memory before dropping oldest (default: 500) */
    maxQueueSize: z.number().int().positive().default(500),
    /** Flush accumulated events every N ms (default: 2000) */
    batchIntervalMs: z.number().int().positive().default(2_000),
    /** Flush immediately when batch reaches this size (default: 50) */
    batchMaxSize: z.number().int().positive().default(50),
  })
  .strict();

// ============================================================
// Full audit config schema
// ============================================================

export const AuditConfigSchema = z
  .object({
    enabled: z.boolean().default(false),

    sinks: z
      .object({
        file: z
          .object({
            enabled: z.boolean().default(true),
            /** Supports ~ expansion */
            path: z.string().default("~/.openclaw/audit/audit.jsonl"),
            /** Max bytes per file before rolling (default: 200 MB) */
            maxFileBytes: z.number().int().positive().default(200 * 1024 * 1024),
            /** Days to retain audit log files (0 = forever) */
            retentionDays: z.number().int().min(0).default(90),
          })
          .strict()
          .optional(),

        webhook: z
          .object({
            enabled: z.boolean().default(false),
            url: z.string().url(),
            headers: z.record(z.string()).optional(),
            timeoutMs: z.number().int().positive().default(5000),
            maxRetries: z.number().int().min(0).default(3),
            /** Max events to buffer in memory before dropping oldest */
            maxQueueSize: z.number().int().positive().default(1000),
            /** Batch flush interval in milliseconds */
            batchIntervalMs: z.number().int().positive().default(500),
            batchMaxSize: z.number().int().positive().default(20),
          })
          .strict()
          .optional(),

        /**
         * MCP sink: forwards audit events to an MCP server tool.
         * Supports mcporter (CLI) and stdio (direct process) transports.
         */
        mcp: McpSinkSchema.optional(),
      })
      .strict()
      .optional(),

    /**
     * Content capture flags.
     * All default to false to avoid storing conversation content by default.
     * Enable only when required by compliance policy and with appropriate storage controls.
     */
    capture: z
      .object({
        /** If true, record raw user message text in user.message events */
        userMessageContent: z.boolean().default(true),
        /** If true, record full prompt in llm.request events */
        llmPromptContent: z.boolean().default(false),
        /** If true, record tool return values in tool.result events */
        toolResults: z.boolean().default(false),
      })
      .strict()
      .optional(),

    redact: z
      .object({
        enabled: z.boolean().default(false),
        /**
         * Additional redaction patterns (regex strings) appended to the core defaults.
         * Core patterns already cover: API keys, tokens, passwords, PEM blocks, common prefixes.
         */
        additionalPatterns: z.array(z.string()).optional(),
        /**
         * Tool parameter field paths (dot-notation) whose values are always redacted.
         * Matched against the full serialized param key.
         */
        paramFields: z
          .array(z.string())
          .default(["token", "secret", "password", "passwd", "key", "appSecret", "encryptKey"]),
      })
      .strict()
      .optional(),

    interception: z
      .object({
        enabled: z.boolean().default(false),
        /**
         * When true, apply built-in enterprise baseline rules before custom rules.
         * Baseline blocks: feishu_perm remove, git push main/master.
         * Baseline audits: all feishu_doc write operations.
         */
        useDefaultRules: z.boolean().default(true),
        /**
         * Custom rules. Evaluated after default rules (if any).
         * First matching rule wins.
         */
        rules: z.array(InterceptRuleSchema).optional(),
      })
      .strict()
      .optional(),

    /**
     * Which event kinds to emit. If omitted, all kinds are emitted.
     * Useful to reduce volume by excluding llm.request/llm.response in low-risk environments.
     */
    eventFilter: z
      .array(
        z.enum([
          "user.message",
          "llm.request",
          "llm.response",
          "tool.call",
          "tool.blocked",
          "tool.result",
          "session.start",
          "session.end",
          "access.denied",
          "skill.install",
        ]),
      )
      .optional(),

    /**
     * Command security policy for bash tool calls.
     * Evaluated before custom interception rules.
     */
    commandPolicy: z
      .object({
        enabled: z.boolean().default(false),
        /**
         * - whitelist: only allow commands in allowedCommands
         * - blacklist: block commands in blockedCommands
         * - audit_only: log but do not block
         */
        mode: z.enum(["whitelist", "blacklist", "audit_only"]).default("blacklist"),
        /** Commands allowed in whitelist mode */
        allowedCommands: z.array(z.string()).optional(),
        /** Commands blocked in blacklist mode */
        blockedCommands: z.array(z.string()).optional(),
        /** Message returned to the LLM when a command is blocked */
        blockMessage: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AuditConfig = z.infer<typeof AuditConfigSchema>;
export type AuditCommandPolicyConfig = NonNullable<AuditConfig["commandPolicy"]>;
export type AuditMcpSinkConfig = z.infer<typeof McpSinkSchema>;
export type AuditMcpTransportConfig = z.infer<typeof McpTransportSchema>;
