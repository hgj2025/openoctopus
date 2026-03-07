import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clamp } from "../../utils.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 500_000;
const MAX_LIMIT = 5000;
const MAX_BYTES = 2_000_000;
const AUDIT_DATE_RE = /^audit-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.jsonl$/;
const DEFAULT_AUDIT_DIR = path.join(os.homedir(), ".openclaw", "audit");
const DEFAULT_AUDIT_BASE = path.join(DEFAULT_AUDIT_DIR, "audit.jsonl");

function resolveAuditBase(): string {
  return DEFAULT_AUDIT_BASE;
}

function resolveAuditDir(base: string): string {
  let p = base;
  if (p.startsWith("~/")) {
    p = path.join(os.homedir(), p.slice(2));
  }
  return path.dirname(p);
}

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function listAuditDates(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const dates = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const m = AUDIT_DATE_RE.exec(entry.name);
      if (m?.[1]) dates.add(m[1]);
    }
    return [...dates].toSorted().reverse();
  } catch {
    return [];
  }
}

async function readAuditSlice(params: {
  file: string;
  cursor?: number;
  limit: number;
  maxBytes: number;
}): Promise<{ cursor: number; size: number; lines: string[]; truncated: boolean; reset: boolean }> {
  const stat = await fs.stat(params.file).catch(() => null);
  if (!stat) {
    return { cursor: 0, size: 0, lines: [], truncated: false, reset: false };
  }
  const size = stat.size;
  const maxBytes = clamp(params.maxBytes, 1, MAX_BYTES);
  const limit = clamp(params.limit, 1, MAX_LIMIT);
  let cursor =
    typeof params.cursor === "number" && Number.isFinite(params.cursor)
      ? Math.max(0, Math.floor(params.cursor))
      : undefined;
  let reset = false;
  let truncated = false;
  let start = 0;

  if (cursor != null) {
    if (cursor > size) {
      reset = true;
      start = Math.max(0, size - maxBytes);
      truncated = start > 0;
    } else {
      start = cursor;
      if (size - start > maxBytes) {
        reset = true;
        truncated = true;
        start = Math.max(0, size - maxBytes);
      }
    }
  } else {
    start = Math.max(0, size - maxBytes);
    truncated = start > 0;
  }

  if (size === 0 || size <= start) {
    return { cursor: size, size, lines: [], truncated, reset };
  }

  const handle = await fs.open(params.file, "r");
  try {
    let prefix = "";
    if (start > 0) {
      const prefixBuf = Buffer.alloc(1);
      const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
      prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
    }
    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    const readResult = await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, readResult.bytesRead);
    let lines = text.split("\n");
    if (start > 0 && prefix !== "\n") lines = lines.slice(1);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
    if (lines.length > limit) lines = lines.slice(lines.length - limit);
    return { cursor: size, size, lines, truncated, reset };
  } finally {
    await handle.close();
  }
}

export const auditHandlers: GatewayRequestHandlers = {
  "audit.tail": async ({ params, respond }) => {
    const p = params as { date?: string; cursor?: number; limit?: number; maxBytes?: number };
    const base = resolveAuditBase();
    const dir = resolveAuditDir(base);
    const date = typeof p.date === "string" && p.date.trim() ? p.date.trim() : todayDateStr();

    try {
      const availableDates = await listAuditDates(dir);
      const file = path.join(dir, `audit-${date}.jsonl`);
      const result = await readAuditSlice({
        file,
        cursor: p.cursor,
        limit: p.limit ?? DEFAULT_LIMIT,
        maxBytes: p.maxBytes ?? DEFAULT_MAX_BYTES,
      });
      respond(true, { file, date, availableDates, ...result }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `audit read failed: ${String(err)}`));
    }
  },
};
