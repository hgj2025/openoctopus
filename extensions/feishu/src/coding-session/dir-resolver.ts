/**
 * Working directory resolution for coding sessions.
 *
 * Classifies the user's task text into one of:
 *   "explicit"  — [workdir:/path] annotation was used (no confirmation needed)
 *   "full"      — ~/path or /abs/path found in text (needs confirmation)
 *   "partial"   — bare name like "tavern" (fuzzy-search + confirmation)
 *   "none"      — no path hint at all (ask user)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type WorkdirHint =
  | { type: "explicit"; path: string }
  | { type: "full"; path: string }
  | { type: "partial"; name: string }
  | { type: "none" };

// Matches ~/path or /abs/path preceded by a Chinese/whitespace boundary
const FULL_PATH_RE =
  /(?:^|[\s去到在:：])([~\/][a-zA-Z0-9_.~\-\/]+)(?:[\s目录,，。.、]|$)/;

// Matches a bare directory name after Chinese navigation words
const PARTIAL_NAME_RE =
  /(?:去|到|在|进入|切换到|cd\s+)([a-zA-Z0-9_\-]+)(?:[\s目录项目文件夹,，。.、]|$)/;

const WORKDIR_TAG_RE = /\[workdir:([^\]]+)\]/i;

const HOME = process.env.HOME ?? "/";

/**
 * Common base directories to search when resolving a partial name.
 * Ordered from most specific to most general.
 */
const SEARCH_BASES = [
  "Code/github",
  "code/github",
  "Code/gitlab",
  "code/gitlab",
  "Code",
  "code",
  "projects",
  "Projects",
  "dev",
  "Dev",
  "repos",
  "work",
  "",            // HOME itself
].map((rel) => (rel ? join(HOME, rel) : HOME));

/**
 * Parse the task body and return a workdir hint.
 * Also returns the cleaned task body (with [workdir:...] tags stripped).
 */
export function extractWorkdirHint(body: string): { hint: WorkdirHint; cleanBody: string } {
  // 1. Explicit [workdir:/path] tag
  const tagMatch = WORKDIR_TAG_RE.exec(body);
  if (tagMatch) {
    const raw = tagMatch[1]!.replace(/\/$/, "");
    const path = expandPath(raw);
    const cleanBody = body.replace(tagMatch[0], "").trim();
    return { hint: { type: "explicit", path }, cleanBody };
  }

  // 2. Full path in text (~/foo or /abs/foo)
  const fullMatch = FULL_PATH_RE.exec(body);
  if (fullMatch) {
    const raw = fullMatch[1]!.replace(/\/$/, "");
    const path = expandPath(raw);
    return { hint: { type: "full", path }, cleanBody: body };
  }

  // 3. Partial name after Chinese nav word
  const partialMatch = PARTIAL_NAME_RE.exec(body);
  if (partialMatch) {
    return { hint: { type: "partial", name: partialMatch[1]! }, cleanBody: body };
  }

  return { hint: { type: "none" }, cleanBody: body };
}

/** Search common locations for directories matching the given name */
export function searchPartialPath(name: string): string[] {
  const results: string[] = [];
  for (const base of SEARCH_BASES) {
    const candidate = join(base, name);
    if (existsSync(candidate)) {
      results.push(displayPath(candidate));
    }
  }
  // Deduplicate (different bases may resolve to same path)
  return [...new Set(results)];
}

/** Expand leading ~ to HOME */
export function expandPath(p: string): string {
  return p.replace(/^~/, HOME);
}

/** Display path with ~ prefix if under HOME */
export function displayPath(p: string): string {
  return HOME && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}
