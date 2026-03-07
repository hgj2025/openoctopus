import type { AuditEvent, AuditSink } from "../types.js";

type WebhookSinkOptions = {
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  maxQueueSize: number;
  batchIntervalMs: number;
  batchMaxSize: number;
};

type BatchEntry = { event: AuditEvent; attempts: number };

/**
 * Async batching webhook sink.
 * Events are buffered in memory and flushed every batchIntervalMs or when batchMaxSize is reached.
 * Failed batches are retried with exponential backoff up to maxRetries times.
 * If the queue exceeds maxQueueSize, the oldest entries are dropped to prevent OOM.
 */
export class WebhookAuditSink implements AuditSink {
  private readonly opts: WebhookSinkOptions;
  private readonly queue: BatchEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: WebhookSinkOptions) {
    this.opts = opts;
    this.scheduleFlush();
  }

  write(event: AuditEvent): void {
    if (this.closed) return;

    // Enforce memory cap: drop oldest entry if over limit
    if (this.queue.length >= this.opts.maxQueueSize) {
      this.queue.shift();
      process.stderr.write(`[audit/webhook] queue full, dropping oldest event\n`);
    }

    this.queue.push({ event, attempts: 0 });

    if (this.queue.length >= this.opts.batchMaxSize) {
      this.flushNow();
    }
  }

  private scheduleFlush(): void {
    if (this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushNow();
      this.scheduleFlush();
    }, this.opts.batchIntervalMs);
    // Don't block process exit
    this.flushTimer.unref?.();
  }

  private flushNow(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.opts.batchMaxSize);
    void this.sendBatch(batch);
  }

  private async sendBatch(batch: BatchEntry[]): Promise<void> {
    const events = batch.map((e) => e.event);
    const body = JSON.stringify({ events });

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
        try {
          const res = await fetch(this.opts.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...this.opts.headers,
            },
            body,
            signal: controller.signal,
          });
          if (res.ok) return;
          // Non-2xx: retry if we have attempts left
          if (attempt === this.opts.maxRetries) {
            process.stderr.write(
              `[audit/webhook] batch failed after ${attempt + 1} attempts: HTTP ${res.status}\n`,
            );
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (attempt === this.opts.maxRetries) {
          process.stderr.write(`[audit/webhook] batch error: ${String(err)}\n`);
        }
      }
      // Exponential backoff: 200ms, 400ms, 800ms, …
      const backoffMs = 200 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  async flush(): Promise<void> {
    const remaining = this.queue.splice(0);
    if (remaining.length === 0) return;
    await this.sendBatch(remaining);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
