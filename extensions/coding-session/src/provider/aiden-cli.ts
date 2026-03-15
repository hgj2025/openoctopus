/**
 * Aiden provider — uses `aiden --stream-json --one-shot` for structured NDJSON output.
 *
 * Event format (relevant subset):
 *   {"type":"event","event":{"name":"message:create","id":"...","content":"...","isStreaming":true}}
 *   {"type":"event","event":{"name":"message:append","id":"...","delta":"..."}}
 *   {"type":"event","event":{"name":"message:update","id":"...","content":"..."}}
 *   {"type":"event","event":{"name":"toolcall:start","id":"...","tool":"Ls","input":"..."}}
 *   {"type":"event","event":{"name":"toolcall:end","id":"...","tool":"Ls","success":true,"output":"..."}}
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  CodingAgentProvider,
  CompleteResult,
  ProgressEvent,
  StartOptions,
} from "./interface.js";

type AidenEvent =
  | { name: "message:create"; id: string; content: string; isStreaming?: boolean }
  | { name: "message:append"; id: string; delta: string }
  | { name: "message:update"; id: string; content: string }
  | { name: "toolcall:start"; id: string; tool: string; input: string }
  | { name: "toolcall:end"; id: string; tool: string; success: boolean; output?: string }
  | { name: string; [k: string]: unknown };

type AidenLine =
  | { type: "event"; event: AidenEvent }
  | { type: "session"; sessionId: string }
  | { type: string; [k: string]: unknown };

export class AidenCliProvider implements CodingAgentProvider {
  readonly name = "aiden";
  readonly supportsToolInterception = false;
  readonly supportsFollowUp = false;

  private readonly binPath: string;
  private progressHandlers: Array<(e: ProgressEvent) => void> = [];
  private completeHandlers: Array<(r: CompleteResult) => void> = [];
  private proc: ReturnType<typeof spawn> | null = null;

  constructor(binPath = "aiden") {
    this.binPath = binPath;
  }

  onProgress(handler: (e: ProgressEvent) => void): void {
    this.progressHandlers.push(handler);
  }

  onComplete(handler: (r: CompleteResult) => void): void {
    this.completeHandlers.push(handler);
  }

  async start({ task, workdir }: StartOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.binPath, ["--stream-json", "--one-shot", task], {
        cwd: workdir,
        env: process.env,
      });

      const rl = createInterface({ input: this.proc.stdout! });

      // Buffer per message-id to assemble streamed tokens
      const msgBuffers = new Map<string, string>();

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed) as AidenLine;
          this.dispatchLine(parsed, msgBuffers);
        } catch {
          // Non-JSON (e.g. "- Check user login status...")
          if (trimmed && !trimmed.startsWith("{")) {
            this.emit({ type: "message", text: trimmed });
          }
        }
      });

      const stderrLines: string[] = [];
      this.proc.stderr?.on("data", (chunk: Buffer) => {
        stderrLines.push(chunk.toString());
      });

      this.proc.on("error", (err) => {
        this.completeHandlers.forEach((h) =>
          h({ success: false, error: `Failed to spawn aiden: ${err.message}` }),
        );
        reject(err);
      });

      this.proc.on("close", (code) => {
        this.completeHandlers.forEach((h) =>
          h({
            success: code === 0,
            error: code === 0 ? undefined : stderrLines.join("").trim() || `Exit code ${code}`,
          }),
        );
        resolve();
      });
    });
  }

  async terminate(): Promise<void> {
    this.proc?.kill("SIGTERM");
  }

  private dispatchLine(line: AidenLine, msgBuffers: Map<string, string>): void {
    if (line.type !== "event") return;

    // Use a plain object for safe property access
    const ev = line.event as Record<string, unknown>;
    const name = ev["name"] as string | undefined;

    switch (name) {
      case "message:create": {
        const id = ev["id"] as string;
        msgBuffers.set(id, (ev["content"] as string | undefined) ?? "");
        this.emit({ type: "thinking", text: "思考中…" });
        break;
      }
      case "message:append": {
        const id = ev["id"] as string;
        const prev = msgBuffers.get(id) ?? "";
        msgBuffers.set(id, prev + ((ev["delta"] as string | undefined) ?? ""));
        break;
      }
      case "message:update": {
        const id = ev["id"] as string;
        const content = (ev["content"] as string | undefined) ?? msgBuffers.get(id) ?? "";
        msgBuffers.delete(id);
        if (content.trim()) {
          this.emit({ type: "message", text: content.trim() });
        }
        break;
      }
      case "toolcall:start": {
        const tool = (ev["tool"] as string | undefined) ?? "unknown";
        this.emit({ type: "tool_start", text: `使用 ${tool}`, toolName: tool });
        break;
      }
      case "toolcall:end": {
        const tool = (ev["tool"] as string | undefined) ?? "unknown";
        const ok = ev["success"] as boolean | undefined;
        this.emit({
          type: "tool_done",
          text: `${ok !== false ? "✅" : "❌"} ${tool}`,
          toolName: tool,
        });
        break;
      }
      // task:performance, session, agent:trace — ignore
    }
  }

  private emit(event: ProgressEvent): void {
    this.progressHandlers.forEach((h) => h(event));
  }
}
