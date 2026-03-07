import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpTransport } from "./mcp-transport.js";

export type StdioTransportOptions = {
  /** Command to spawn (e.g. "node") */
  command: string;
  /** Command arguments (e.g. ["/path/to/audit-mcp-server.js"]) */
  args?: string[];
  /** Additional environment variables for the child process */
  env?: Record<string, string>;
  /** Timeout for MCP initialize handshake in ms */
  initTimeoutMs?: number;
  /** Timeout for each tool call in ms */
  timeoutMs: number;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const MCP_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_INIT_TIMEOUT_MS = 10_000;

/**
 * MCP transport over stdio using the raw MCP JSON-RPC 2.0 protocol.
 *
 * Spawns a long-lived MCP server process and communicates via stdin/stdout.
 * Message framing: newline-delimited JSON (one JSON object per line).
 *
 * Lifecycle:
 *   1. Spawn child process
 *   2. Send "initialize" request → await response
 *   3. Send "notifications/initialized" notification
 *   4. Ready to call tools via "tools/call" requests
 *   5. On close: send "notifications/cancelled" (best-effort) then kill
 */
export class StdioTransport implements McpTransport {
  private readonly opts: Required<StdioTransportOptions>;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(opts: StdioTransportOptions) {
    this.opts = {
      args: [],
      env: {},
      initTimeoutMs: DEFAULT_INIT_TIMEOUT_MS,
      ...opts,
    };
  }

  // ============================================================
  // Initialization
  // ============================================================

  private async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const child = spawn(this.opts.command, this.opts.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.opts.env },
      });
      this.child = child;

      // Route stderr to our stderr for visibility
      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(`[audit/mcp/stdio] server stderr: ${chunk.toString("utf8")}`);
      });

      child.on("exit", (code, signal) => {
        if (!this.closed) {
          process.stderr.write(
            `[audit/mcp/stdio] server exited unexpectedly code=${code} signal=${signal}\n`,
          );
        }
        this.rejectAllPending(new Error(`MCP server exited (code=${code} signal=${signal})`));
        this.child = null;
      });

      child.on("error", (err) => {
        process.stderr.write(`[audit/mcp/stdio] spawn error: ${String(err)}\n`);
        this.rejectAllPending(new Error(`MCP server spawn error: ${String(err)}`));
        this.child = null;
      });

      // Parse newline-delimited JSON from stdout
      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse;
          if (typeof msg.id === "number") {
            const pending = this.pending.get(msg.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(msg.id);
              if (msg.error) {
                pending.reject(
                  new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
                );
              } else {
                pending.resolve(msg.result);
              }
            }
          }
          // Notifications (no id) are silently ignored
        } catch {
          // Non-JSON line from server — ignore
        }
      });

      // MCP initialize handshake
      await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "openclaw-audit", version: "1.0.0" },
        },
        this.opts.initTimeoutMs,
      );

      // Confirm initialization (notification, no id)
      this.notify("notifications/initialized", {});
    })();

    return this.initPromise;
  }

  // ============================================================
  // JSON-RPC helpers
  // ============================================================

  private send(msg: JsonRpcRequest): void {
    if (!this.child?.stdin?.writable) {
      throw new Error("MCP server stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(msg)}\n`, "utf8");
  }

  private notify(method: string, params: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {
      // Notifications are best-effort
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" id=${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Don't block process exit
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  // ============================================================
  // Public API
  // ============================================================

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error("StdioTransport is closed");
    await this.initialize();
    return this.request(
      "tools/call",
      { name: toolName, arguments: args },
      this.opts.timeoutMs,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.rejectAllPending(new Error("StdioTransport closed"));

    const child = this.child;
    if (!child) return;

    // Ask server to stop gracefully
    this.notify("notifications/cancelled", { reason: "shutdown" });

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
      forceKill.unref?.();

      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });

      child.stdin?.end();
    });

    this.child = null;
  }
}
