/**
 * Persist recently used working directories per chat context.
 * Stored as a simple JSON file in ~/.openclaw/coding-session-dirs.json.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = join(process.env.HOME ?? "/tmp", ".openclaw");
const FILE = join(DATA_DIR, "coding-session-dirs.json");
const MAX_RECENT = 5;

interface Store {
  dirs: string[];
}

async function load(): Promise<string[]> {
  try {
    const raw = await readFile(FILE, "utf-8");
    return (JSON.parse(raw) as Store).dirs ?? [];
  } catch {
    return [];
  }
}

export async function getRecentDirs(): Promise<string[]> {
  return load();
}

export async function addRecentDir(dir: string): Promise<void> {
  const current = await load();
  // Normalize: store with ~ prefix if under HOME
  const home = process.env.HOME ?? "";
  const display = home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
  const updated = [display, ...current.filter((d) => d !== display)].slice(0, MAX_RECENT);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify({ dirs: updated }, null, 2));
}
