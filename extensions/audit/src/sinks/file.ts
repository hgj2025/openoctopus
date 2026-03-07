import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuditEvent, AuditSink } from "../types.js";

type FileSinkOptions = {
  path: string;
  maxFileBytes: number;
  retentionDays: number;
};

function resolveUserPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Build a dated file path: /dir/audit-2026-03-06.jsonl */
function buildDatedPath(basePath: string): string {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const base = path.basename(basePath, ext);
  const today = new Date().toISOString().slice(0, 10);
  return path.join(dir, `${base}-${today}${ext}`);
}

function pruneOldFiles(dir: string, prefix: string, retentionDays: number): void {
  if (retentionDays === 0) return;
  try {
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const { mtimeMs } = fs.statSync(fullPath);
        if (mtimeMs < cutoffMs) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // best effort
      }
    }
  } catch {
    // ignore
  }
}

/**
 * JSONL file sink with per-day rolling and retention pruning.
 * Writes are synchronous (appendFileSync) to ensure durability on process crash.
 */
export class FileAuditSink implements AuditSink {
  private readonly opts: FileSinkOptions;
  private readonly resolvedBase: string;
  private currentFile = "";
  private currentBytes = 0;
  private rollIndex = 0;

  constructor(opts: FileSinkOptions) {
    this.opts = opts;
    this.resolvedBase = resolveUserPath(opts.path);
    this.ensureDir();
    this.pruneIfNeeded();
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(path.dirname(this.resolvedBase), { recursive: true });
    } catch {
      // ignore
    }
  }

  private pruneIfNeeded(): void {
    const dir = path.dirname(this.resolvedBase);
    const prefix = path.basename(this.resolvedBase, path.extname(this.resolvedBase));
    pruneOldFiles(dir, prefix, this.opts.retentionDays);
  }

  private resolveCurrentFile(): string {
    const dated = buildDatedPath(this.resolvedBase);
    if (dated !== this.currentFile) {
      // Day rolled over — start fresh
      this.currentFile = dated;
      this.rollIndex = 0;
      try {
        this.currentBytes = fs.statSync(dated).size;
      } catch {
        this.currentBytes = 0;
      }
      this.pruneIfNeeded();
    }

    // Size-based rolling: append .1, .2, … suffix
    if (this.currentBytes >= this.opts.maxFileBytes && this.rollIndex < 999) {
      this.rollIndex += 1;
      const ext = path.extname(this.currentFile);
      const base = this.currentFile.slice(0, -ext.length);
      this.currentFile = `${base}.${this.rollIndex}${ext}`;
      this.currentBytes = 0;
    }

    return this.currentFile;
  }

  write(event: AuditEvent): void {
    try {
      const file = this.resolveCurrentFile();
      const line = `${JSON.stringify(event)}\n`;
      fs.appendFileSync(file, line, { encoding: "utf8" });
      this.currentBytes += Buffer.byteLength(line, "utf8");
    } catch (err) {
      // Never throw from a sink — log to stderr only
      process.stderr.write(`[audit/file] write error: ${String(err)}\n`);
    }
  }

  /**
   * Seal the current file with a SHA-256 integrity hash.
   * Call this during graceful shutdown to allow later tamper detection.
   */
  async seal(): Promise<void> {
    const file = this.currentFile;
    if (!file) return;
    try {
      const content = await fs.promises.readFile(file, "utf8");
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      const sealLine = `${JSON.stringify({ type: "file.seal", file, hash, ts: Date.now() })}\n`;
      await fs.promises.appendFile(file, sealLine, { encoding: "utf8" });
    } catch {
      // best effort
    }
  }

  async close(): Promise<void> {
    await this.seal();
  }
}
