/**
 * Claude Code provider via CLI with `--output-format stream-json`.
 *
 * Uses structured JSON output instead of raw PTY — no ANSI stripping needed.
 * Tool interception is NOT supported in this mode (auto-approve via --dangerously-skip-permissions).
 * For SDK-based interception, use claude-code-sdk.ts (future).
 */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type {
  CodingAgentProvider,
  CompleteResult,
  ProgressEvent,
  StartOptions,
} from "./interface.js";

type SDKEvent =
  | { type: "system"; subtype: string }
  | { type: "assistant"; message: { content: Array<{ type: string; text?: string; name?: string; thinking?: string }> } }
  | { type: "tool_use"; toolUseBlock: { name: string; input: Record<string, unknown> } }
  | { type: "tool_result"; toolResult: { content?: string } }
  | { type: "result"; subtype: "success" | "error"; result?: string; error?: string; is_error?: boolean };

export class ClaudeCodeCliProvider implements CodingAgentProvider {
  readonly name = "claude-code";
  readonly supportsToolInterception = false;
  readonly supportsFollowUp = false;

  private readonly binPath: string;
  private progressHandlers: Array<(e: ProgressEvent) => void> = [];
  private completeHandlers: Array<(r: CompleteResult) => void> = [];
  private proc: ReturnType<typeof spawn> | null = null;
  /** Captured from the result event to use as completion summary */
  private resultSummary: string | undefined = undefined;

  constructor(binPath = "claude") {
    this.binPath = binPath;
  }

  onProgress(handler: (e: ProgressEvent) => void): void {
    this.progressHandlers.push(handler);
  }

  onComplete(handler: (r: CompleteResult) => void): void {
    this.completeHandlers.push(handler);
  }

  async start({ task, workdir }: StartOptions): Promise<void> {
    // Pre-flight checks — give actionable errors instead of cryptic ENOENT
    if (!existsSync(workdir)) {
      throw new Error(`Working directory does not exist: ${workdir}`);
    }

    // Resolve the binary path fresh at start time (handles auto-updates that move the binary).
    // Prefer the path we were given, but if it doesn't exist, re-resolve via shell.
    let bin = this.binPath;
    if (bin.startsWith("/") && !existsSync(bin)) {
      try {
        bin = execSync("which claude", { encoding: "utf-8" }).trim();
      } catch {
        throw new Error(`Claude binary not found: ${this.binPath} (also not in PATH)`);
      }
    }

    return new Promise((resolve, reject) => {
      const args = ["-p", task, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];

      this.proc = spawn(bin, args, { cwd: workdir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      // Close stdin — -p mode doesn't need input and some versions block on an open pipe
      this.proc.stdin?.end();

      const rl = createInterface({ input: this.proc.stdout! });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed) as SDKEvent;
          this.dispatchSDKEvent(event);
        } catch {
          // Non-JSON line — surface as message
          this.emit({ type: "message", text: trimmed });
        }
      });

      // Collect stderr for error context
      const stderrLines: string[] = [];
      this.proc.stderr?.on("data", (chunk: Buffer) => {
        stderrLines.push(chunk.toString());
      });

      let errorHandled = false;
      this.proc.on("error", (err) => {
        errorHandled = true;
        this.completeHandlers.forEach((h) =>
          h({ success: false, error: `Failed to spawn ${this.binPath}: ${err.message}` }),
        );
        reject(err);
      });

      this.proc.on("close", (code) => {
        if (errorHandled) return; // Already reported via "error" event
        const success = code === 0;
        this.completeHandlers.forEach((h) =>
          h({
            success,
            summary: success ? this.resultSummary : undefined,
            error: success ? undefined : stderrLines.join("").trim() || `Exit code ${code}`,
          }),
        );
        resolve();
      });
    });
  }

  async terminate(): Promise<void> {
    this.proc?.kill("SIGTERM");
  }

  private dispatchSDKEvent(event: SDKEvent): void {
    switch (event.type) {
      case "assistant": {
        for (const block of event.message.content) {
          if (block.type === "thinking") {
            // Emit a thinking progress event so the card shows "Thinking…" instead of staying stuck
            this.emit({ type: "thinking", text: "Thinking…" });
          } else if (block.type === "text" && block.text) {
            this.emit({ type: "message", text: block.text });
          } else if (block.type === "tool_use" && block.name) {
            this.emit({ type: "tool_start", text: `Using ${block.name}`, toolName: block.name });
          }
        }
        break;
      }
      case "tool_use": {
        this.emit({ type: "tool_start", text: `Using ${event.toolUseBlock.name}`, toolName: event.toolUseBlock.name });
        break;
      }
      case "tool_result": {
        this.emit({ type: "tool_done", text: "Done" });
        break;
      }
      case "result": {
        if (event.subtype === "success" && event.result) {
          // Capture summary for CompleteResult; also emit as final message
          this.resultSummary = event.result;
          this.emit({ type: "message", text: event.result });
        } else if (event.subtype === "error" || event.is_error) {
          this.emit({ type: "error", text: event.error ?? "Unknown error" });
        }
        break;
      }
    }
  }

  private emit(event: ProgressEvent): void {
    this.progressHandlers.forEach((h) => h(event));
  }
}
