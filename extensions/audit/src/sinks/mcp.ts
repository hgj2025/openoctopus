import type { AuditEvent, AuditSink } from "../types.js";
import type { McpTransport } from "./mcp-transport.js";
import { McporterTransport, type McporterTransportOptions } from "./mcp-transport-mcporter.js";
import { StdioTransport, type StdioTransportOptions } from "./mcp-transport-stdio.js";

// ============================================================
// Config types (mirrors config-schema.ts AuditMcpSinkConfig)
// ============================================================

export type McpSinkTransportConfig =
  | ({ kind: "mcporter" } & McporterTransportOptions)
  | ({ kind: "stdio" } & StdioTransportOptions);

export type McpSinkOptions = {
  transport: McpSinkTransportConfig;
  /** MCP tool name to invoke for audit log submission */
  toolName: string;
  /** Max retry attempts on transient failure (default: 3) */
  maxRetries?: number;
  /** Max events to hold in memory before dropping oldest (default: 500) */
  maxQueueSize?: number;
  /** Flush accumulated events every N ms (default: 2000) */
  batchIntervalMs?: number;
  /** Flush when batch reaches this size before interval fires (default: 50) */
  batchMaxSize?: number;
};

const DEFAULTS = {
  maxRetries: 3,
  maxQueueSize: 500,
  batchIntervalMs: 2_000,
  batchMaxSize: 50,
} as const;

// ============================================================
// Batch payload
// ============================================================

/**
 * The payload sent to the MCP tool on each batch call.
 * MCP servers implementing the audit protocol should accept this shape.
 */
type AuditBatchPayload = {
  events: AuditEvent[];
  /** ISO 8601 timestamp of the batch flush */
  batchTime: string;
  /** Number of events in this batch */
  count: number;
};

// ============================================================
// Sink
// ============================================================

/**
 * MCP audit sink.
 *
 * Buffers events and periodically flushes them to an MCP server tool call.
 * The tool is expected to accept { events: AuditEvent[] } as its argument.
 *
 * Supports two transport implementations:
 *  - "mcporter": delegates to the `mcporter` CLI (no extra deps, matches codebase pattern)
 *  - "stdio": long-lived JSON-RPC 2.0 process (lower latency, direct protocol)
 *
 * Failures never propagate to the caller — they are logged to stderr and retried.
 * After maxRetries exhaustion, the batch is dropped to prevent unbounded growth.
 */
export class McpAuditSink implements AuditSink {
  private readonly opts: Required<McpSinkOptions>;
  private readonly transport: McpTransport;
  private readonly queue: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private closed = false;

  constructor(opts: McpSinkOptions) {
    this.opts = {
      maxRetries: DEFAULTS.maxRetries,
      maxQueueSize: DEFAULTS.maxQueueSize,
      batchIntervalMs: DEFAULTS.batchIntervalMs,
      batchMaxSize: DEFAULTS.batchMaxSize,
      ...opts,
    };
    this.transport = buildTransport(opts.transport);
    this.scheduleFlush();
  }

  // ============================================================
  // AuditSink interface
  // ============================================================

  write(event: AuditEvent): void {
    if (this.closed) return;

    if (this.queue.length >= this.opts.maxQueueSize) {
      // Drop oldest to make room — prevents OOM on slow/down server
      this.queue.shift();
      process.stderr.write("[audit/mcp] queue full, dropping oldest event\n");
    }

    this.queue.push(event);

    if (this.queue.length >= this.opts.batchMaxSize) {
      this.flushNow();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    await this.sendBatch(batch, 0);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Drain remaining events
    await this.flush();

    // Wait for in-flight sends to settle (up to 5s)
    const deadline = Date.now() + 5_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    await this.transport.close();
  }

  // ============================================================
  // Internal
  // ============================================================

  private scheduleFlush(): void {
    if (this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushNow();
      this.scheduleFlush();
    }, this.opts.batchIntervalMs);
    this.flushTimer.unref?.();
  }

  private flushNow(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.opts.batchMaxSize);
    this.inFlight++;
    void this.sendBatch(batch, 0).finally(() => {
      this.inFlight--;
    });
  }

  private async sendBatch(batch: AuditEvent[], attempt: number): Promise<void> {
    const payload: AuditBatchPayload = {
      events: batch,
      batchTime: new Date().toISOString(),
      count: batch.length,
    };

    try {
      await this.transport.callTool(this.opts.toolName, payload as unknown as Record<string, unknown>);
    } catch (err) {
      if (attempt < this.opts.maxRetries) {
        const backoffMs = 300 * 2 ** attempt; // 300ms, 600ms, 1200ms, …
        await new Promise((r) => setTimeout(r, backoffMs));
        return this.sendBatch(batch, attempt + 1);
      }
      process.stderr.write(
        `[audit/mcp] batch of ${batch.length} events dropped after ${attempt} retries: ${String(err)}\n`,
      );
    }
  }
}

// ============================================================
// Factory
// ============================================================

function buildTransport(cfg: McpSinkTransportConfig): McpTransport {
  if (cfg.kind === "mcporter") {
    const { kind: _kind, ...opts } = cfg;
    return new McporterTransport(opts);
  }
  if (cfg.kind === "stdio") {
    const { kind: _kind, ...opts } = cfg;
    return new StdioTransport(opts);
  }
  // TypeScript exhaustiveness guard
  const _exhaustive: never = cfg;
  throw new Error(`Unknown MCP transport kind: ${(_exhaustive as McpSinkTransportConfig).kind}`);
}
