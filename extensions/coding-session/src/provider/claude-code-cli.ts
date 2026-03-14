/**
 * Claude Code provider via CLI with `--output-format stream-json`.
 *
 * Uses structured JSON output instead of raw PTY — no ANSI stripping needed.
 * Tool interception is NOT supported in this mode (auto-approve via --dangerously-skip-permissions).
 * For SDK-based interception, use claude-code-sdk.ts (future).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  CodingAgentProvider,
  CompleteResult,
  ProgressEvent,
  StartOptions,
} from "./interface.js";

type SDKEvent =
  | { type: "system"; subtype: string }
  | { type: "assistant"; message: { content: Array<{ type: string; text?: string; name?: string }> } }
  | { type: "tool_use"; toolUseBlock: { name: string; input: Record<string, unknown> } }
  | { type: "tool_result"; toolResult: { content?: string } }
  | { type: "result"; subtype: "success" | "error"; result?: string; error?: string };

export class ClaudeCodeCliProvider implements CodingAgentProvider {
  readonly name = "claude-code";
  readonly supportsToolInterception = false;
  readonly supportsFollowUp = false;

  private progressHandlers: Array<(e: ProgressEvent) => void> = [];
  private completeHandlers: Array<(r: CompleteResult) => void> = [];
  private proc: ReturnType<typeof spawn> | null = null;

  onProgress(handler: (e: ProgressEvent) => void): void {
    this.progressHandlers.push(handler);
  }

  onComplete(handler: (r: CompleteResult) => void): void {
    this.completeHandlers.push(handler);
  }

  async start({ task, workdir }: StartOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn(
        "claude",
        ["-p", task, "--output-format", "stream-json", "--dangerously-skip-permissions"],
        { cwd: workdir, env: process.env },
      );

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

      this.proc.on("error", (err) => {
        this.completeHandlers.forEach((h) =>
          h({ success: false, error: `Failed to spawn claude: ${err.message}` }),
        );
        reject(err);
      });

      this.proc.on("close", (code) => {
        const success = code === 0;
        this.completeHandlers.forEach((h) =>
          h({
            success,
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
          if (block.type === "text" && block.text) {
            this.emit({ type: "message", text: block.text });
          } else if (block.type === "tool_use" && block.name) {
            this.emit({ type: "tool_start", text: `Using ${block.name}`, toolName: block.name });
          }
        }
        break;
      }
      case "tool_result": {
        this.emit({ type: "tool_done", text: "Done" });
        break;
      }
      case "result": {
        if (event.subtype === "error") {
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
