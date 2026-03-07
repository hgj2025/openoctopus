import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { McpTransport } from "./mcp-transport.js";

export type McporterTransportOptions = {
  /** mcporter server name, e.g. "audit-server" */
  serverName: string;
  /** Call timeout in ms passed to mcporter --timeout */
  timeoutMs: number;
  /**
   * Auto-start the mcporter daemon before the first call.
   * Avoids cold-start latency on subsequent calls.
   */
  startDaemon: boolean;
  /** Max output bytes to capture from mcporter stdout/stderr */
  maxOutputChars?: number;
};

const DEFAULT_MAX_OUTPUT_CHARS = 512 * 1024; // 512 KB

/** Resolve Windows .cmd shim for mcporter (mirrors qmd-manager.ts pattern) */
function resolveCommand(): string {
  if (process.platform !== "win32") return "mcporter";
  return "mcporter.cmd";
}

function spawnMcporter(
  args: string[],
  opts: { timeoutMs?: number; maxOutputChars: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCommand(), args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let truncated = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`mcporter ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < opts.maxOutputChars) {
        stdout += chunk.toString("utf8");
      } else {
        truncated = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < opts.maxOutputChars) {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (truncated) {
        reject(new Error(`mcporter output truncated (>${opts.maxOutputChars} chars)`));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(`mcporter ${args.join(" ")} exited with code ${code}: ${stderr || stdout}`),
        );
      }
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`mcporter spawn error: ${String(err)}`));
    });
  });
}

// Global daemon-start promise shared across all transport instances (one per process).
let daemonStartPromise: Promise<void> | null = null;

/**
 * MCP transport implemented via the `mcporter` CLI.
 *
 * Invocation pattern (mirrors qmd-manager.ts):
 *   mcporter call <serverName>.<toolName> --args <json> --output json --timeout <ms>
 *
 * Each call spawns a separate mcporter process. When startDaemon=true, a long-lived
 * `mcporter daemon` is started first so that subsequent calls are warm.
 */
export class McporterTransport implements McpTransport {
  private readonly opts: Required<McporterTransportOptions>;
  private daemonStarted = false;

  constructor(opts: McporterTransportOptions) {
    this.opts = {
      maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
      ...opts,
    };
  }

  private async ensureDaemon(): Promise<void> {
    if (!this.opts.startDaemon || this.daemonStarted) return;
    if (!daemonStartPromise) {
      daemonStartPromise = spawnMcporter(["daemon", "start"], {
        timeoutMs: 15_000,
        maxOutputChars: this.opts.maxOutputChars,
      })
        .then(() => {
          this.daemonStarted = true;
        })
        .catch((err) => {
          // Non-fatal: calls can still proceed without daemon
          process.stderr.write(
            `[audit/mcp/mcporter] daemon start failed (calls will cold-start): ${String(err)}\n`,
          );
          daemonStartPromise = null;
        });
    }
    await daemonStartPromise;
    this.daemonStarted = true;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureDaemon();

    const selector = `${this.opts.serverName}.${toolName}`;
    const { stdout } = await spawnMcporter(
      [
        "call",
        selector,
        "--args",
        JSON.stringify(args),
        "--output",
        "json",
        "--timeout",
        String(Math.max(0, this.opts.timeoutMs)),
      ],
      { timeoutMs: this.opts.timeoutMs + 3_000, maxOutputChars: this.opts.maxOutputChars },
    );

    try {
      return JSON.parse(stdout.trim());
    } catch {
      // If we can't parse the output, return raw string — the sink doesn't use return values
      return stdout.trim();
    }
  }

  async close(): Promise<void> {
    // mcporter CLI is stateless (per-call spawn), nothing to tear down
  }
}
