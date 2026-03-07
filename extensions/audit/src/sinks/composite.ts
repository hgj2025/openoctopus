import type { AuditEvent, AuditSink } from "../types.js";

/**
 * Fan-out sink: writes to all registered sinks.
 * Errors in one sink never affect others.
 */
export class CompositeAuditSink implements AuditSink {
  private readonly sinks: AuditSink[];

  constructor(sinks: AuditSink[]) {
    this.sinks = sinks;
  }

  write(event: AuditEvent): void {
    for (const sink of this.sinks) {
      try {
        const result = sink.write(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            process.stderr.write(`[audit/composite] sink write error: ${String(err)}\n`);
          });
        }
      } catch (err) {
        process.stderr.write(`[audit/composite] sink write error: ${String(err)}\n`);
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.flush?.()));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.close?.()));
  }
}
