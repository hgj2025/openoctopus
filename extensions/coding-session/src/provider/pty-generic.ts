/**
 * Generic PTY provider — wraps any coding agent CLI (codex, opencode, pi, aider, …).
 *
 * Spawns the process with a pseudo-terminal so interactive CLIs work correctly.
 * Tool interception is NOT supported; output is parsed as plain text.
 * Follow-up messages are sent via stdin.
 *
 * Requires `node-pty` to be available in the environment.
 * If unavailable, falls back to child_process.spawn (no PTY, may break interactive agents).
 */

import { spawn } from "node:child_process";
import type {
  CodingAgentProvider,
  CompleteResult,
  ProgressEvent,
  StartOptions,
} from "./interface.js";

// Strip ANSI escape codes from terminal output
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\r/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export class PTYGenericProvider implements CodingAgentProvider {
  readonly name: string;
  readonly supportsToolInterception = false;
  readonly supportsFollowUp = true;

  private progressHandlers: Array<(e: ProgressEvent) => void> = [];
  private completeHandlers: Array<(r: CompleteResult) => void> = [];
  private stdinWrite: ((data: string) => void) | null = null;

  /**
   * @param command  Full shell command to run, e.g. "codex exec" or "opencode run"
   * @param name     Display name for this provider
   */
  constructor(
    private readonly command: string,
    name?: string,
  ) {
    this.name = name ?? command.split(" ")[0] ?? command;
  }

  onProgress(handler: (e: ProgressEvent) => void): void {
    this.progressHandlers.push(handler);
  }

  onComplete(handler: (r: CompleteResult) => void): void {
    this.completeHandlers.push(handler);
  }

  async start({ task, workdir }: StartOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      // Try node-pty first; fall back to child_process.spawn
      let pty: { write: (s: string) => void; kill: () => void } | null = null;
      let fallbackProc: ReturnType<typeof spawn> | null = null;

      const parts = [...this.command.split(" "), task];
      const bin = parts[0]!;
      const args = parts.slice(1);

      type NodePtyModule = {
        spawn: (bin: string, args: string[], opts: Record<string, unknown>) => {
          write: (s: string) => void;
          kill: () => void;
          onData: (cb: (data: string) => void) => void;
          onExit: (cb: (e: { exitCode: number }) => void) => void;
        };
      };

      try {
        // Dynamic require so node-pty stays an optional runtime dep
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const nodePty = require("node-pty") as NodePtyModule;
        const ptyProc = nodePty.spawn(bin, args, {
          name: "xterm-256color",
          cwd: workdir,
          env: process.env as Record<string, string>,
        });

        pty = { write: (s) => ptyProc.write(s), kill: () => ptyProc.kill() };
        this.stdinWrite = (s) => ptyProc.write(s);

        ptyProc.onData((data: string) => {
          const text = stripAnsi(data).trim();
          if (text) this.emit({ type: "message", text });
        });

        ptyProc.onExit((e: { exitCode: number }) => {
          this.completeHandlers.forEach((h) => h({ success: e.exitCode === 0 }));
          resolve();
        });
      } catch {
        // node-pty unavailable — fall back to spawn
        fallbackProc = spawn(bin, args, {
          cwd: workdir,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });

        this.stdinWrite = (s) => fallbackProc!.stdin!.write(s + "\n");

        const emit = (data: Buffer) => {
          const text = stripAnsi(data.toString()).trim();
          if (text) this.emit({ type: "message", text });
        };
        fallbackProc.stdout?.on("data", emit);
        fallbackProc.stderr?.on("data", emit);

        fallbackProc.on("error", (err) => {
          this.completeHandlers.forEach((h) =>
            h({ success: false, error: `Failed to spawn ${bin}: ${err.message}` }),
          );
          reject(err);
        });

        fallbackProc.on("close", (code) => {
          this.completeHandlers.forEach((h) => h({ success: code === 0 }));
          resolve();
        });
      }

      // Suppress unused variable warning
      void pty;
      void fallbackProc;
    });
  }

  async sendFollowUp(message: string): Promise<void> {
    this.stdinWrite?.(message);
  }

  async terminate(): Promise<void> {
    this.stdinWrite?.("\x03"); // Ctrl-C
  }

  private emit(event: ProgressEvent): void {
    this.progressHandlers.forEach((h) => h(event));
  }
}
