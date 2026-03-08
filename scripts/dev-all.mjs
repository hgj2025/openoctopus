#!/usr/bin/env node
/**
 * Dev launcher: starts gateway (backend) + UI (frontend) together.
 *
 * Controls (stdin):
 *   r   — restart both processes
 *   b   — restart backend only
 *   f   — restart frontend only
 *   q   — quit
 *   Ctrl+C — quit
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const colors = {
  backend: "\x1b[36m",  // cyan
  frontend: "\x1b[35m", // magenta
  sys: "\x1b[33m",      // yellow
};

function label(name) {
  return `${BOLD}${colors[name]}[${name === "backend" ? "BE" : name === "frontend" ? "FE" : "SYS"}]${RESET} `;
}

function syslog(msg) {
  process.stdout.write(`${label("sys")}${DIM}${msg}${RESET}\n`);
}

function printHelp() {
  syslog("r=restart all  b=restart backend  f=restart frontend  q=quit");
}

// ── Process management ────────────────────────────────────────────────────────
// Use process.execPath (the actual node binary) to avoid nvm lazy-load issues
// when spawning child processes without a full shell environment.
// Also inject the node bin dir into PATH so that child processes that invoke
// other scripts via `#!/usr/bin/env node` can resolve the binary.
const NODE = process.execPath;
const nodeDir = path.dirname(NODE);
const childEnv = {
  ...process.env,
  PATH: process.env.PATH
    ? `${nodeDir}${path.delimiter}${process.env.PATH}`
    : nodeDir,
};

const PROCS = {
  backend: {
    name: "backend",
    cmd: NODE,
    args: ["scripts/run-node.mjs", "gateway"],
    cwd: repoRoot,
    env: { ...childEnv },
    child: null,
    restarting: false,
  },
  frontend: {
    name: "frontend",
    cmd: NODE,
    args: ["scripts/ui.js", "dev"],
    cwd: repoRoot,
    env: { ...childEnv },
    child: null,
    restarting: false,
  },
};

function pipeOutput(child, name) {
  const prefix = label(name);
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) process.stdout.write(`${prefix}${line}\n`);
      }
    });
  }
}

function killPort(port) {
  try {
    const r = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" });
    const pids = (r.stdout || "").trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ }
    }
    if (pids.length) syslog(`Cleared stale process(es) on port ${port}: ${pids.join(", ")}`);
  } catch { /* lsof not available */ }
}

// Kill any openclaw/openclaw-gateway processes started before this launcher
// to avoid gateway lock/port conflicts from a previous unclean shutdown.
function killStaleGatewayProcs() {
  try {
    const r = spawnSync("pgrep", ["-f", "openclaw"], { encoding: "utf8" });
    const pids = (r.stdout || "").trim().split("\n").filter(Boolean).map(Number).filter(Boolean);
    const stale = pids.filter((pid) => pid !== process.pid && pid < process.pid);
    for (const pid of stale) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    if (stale.length) syslog(`Cleared stale gateway process(es): ${stale.join(", ")}`);
  } catch { /* pgrep not available */ }
}

// Circuit-breaker: if a process crashes N times within CRASH_WINDOW_MS it is
// considered stuck (e.g. bad config) and auto-restart is suspended until the
// user manually intervenes (press the restart key).
const CRASH_WINDOW_MS = 10_000;
const CRASH_LIMIT = 3;

function startProc(key) {
  const p = PROCS[key];
  if (p.child) return; // already running

  // Circuit-breaker: refuse to start if too many recent rapid crashes
  if (p.crashTimes && p.crashTimes.length >= CRASH_LIMIT) {
    syslog(`${BOLD}${colors[p.name] ?? ""}${p.name}${RESET} crashed ${p.crashTimes.length} times in <${CRASH_WINDOW_MS / 1000}s — auto-restart suspended.`);
    syslog(`Fix the error then press '${key === "backend" ? "b" : "f"}' to restart manually.`);
    p.crashTimes = [];
    return;
  }

  // Clear stale processes that might have survived a previous unclean shutdown
  if (key === "frontend") killPort(5173);

  syslog(`Starting ${p.name}…`);
  const child = spawn(p.cmd, p.args, {
    cwd: p.cwd,
    env: p.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Create a new process group so we can kill the whole subtree (e.g. vite)
    detached: true,
  });
  p.child = child;
  p.startedAt = Date.now();

  pipeOutput(child, p.name);

  child.on("error", (err) => {
    syslog(`${p.name} error: ${err.message}`);
    p.child = null;
  });

  child.on("exit", (code, signal) => {
    p.child = null;
    if (p.restarting) {
      p.restarting = false;
      p.crashTimes = []; // intentional restart resets circuit-breaker
      startProc(key);
      return;
    }
    if (signal !== "SIGTERM" && signal !== "SIGKILL") {
      const uptime = Date.now() - (p.startedAt ?? Date.now());
      if (uptime < CRASH_WINDOW_MS) {
        // Rapid crash — track for circuit-breaker
        p.crashTimes = (p.crashTimes ?? []).filter((t) => Date.now() - t < CRASH_WINDOW_MS);
        p.crashTimes.push(Date.now());
      } else {
        p.crashTimes = []; // lived long enough — reset
      }
      syslog(`${p.name} exited (code=${code ?? "?"}, signal=${signal ?? "none"}) — auto-restarting in 2s…`);
      setTimeout(() => startProc(key), 2000);
    }
  });
}

function killProc(key, cb) {
  const p = PROCS[key];
  if (!p.child) {
    cb?.();
    return;
  }
  p.restarting = true;
  const child = p.child;
  const done = () => {
    p.child = null;
    cb?.();
  };
  child.once("exit", done);
  // Kill the whole process group (covers vite, pnpm, etc.)
  const killGroup = (sig) => {
    try { process.kill(-child.pid, sig); } catch { child.kill(sig); }
  };
  killGroup("SIGTERM");
  setTimeout(() => {
    if (p.child === child) killGroup("SIGKILL");
  }, 3000);
}

function restartProc(key) {
  syslog(`Restarting ${PROCS[key].name}…`);
  if (PROCS[key].child) {
    killProc(key, () => startProc(key));
  } else {
    startProc(key);
  }
}

function restartAll() {
  syslog("Restarting all…");
  killProc("backend");
  killProc("frontend");
  // Both will auto-start via restarting flag
}

function shutdown() {
  syslog("Shutting down…");
  for (const key of Object.keys(PROCS)) {
    const p = PROCS[key];
    p.restarting = false; // prevent auto-restart
    if (p.child) {
      try { process.kill(-p.child.pid, "SIGTERM"); } catch { p.child.kill("SIGTERM"); }
    }
  }
  setTimeout(() => process.exit(0), 1500);
}

// ── Keyboard input ────────────────────────────────────────────────────────────
function setupKeyboard() {
  if (!process.stdin.isTTY) return;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", (str, key) => {
    if (!key) return;
    if ((key.ctrl && key.name === "c") || str === "q") {
      shutdown();
      return;
    }
    if (str === "r") { restartAll(); return; }
    if (str === "b") { restartProc("backend"); return; }
    if (str === "f") { restartProc("frontend"); return; }
  });
}

// ── Unix socket IPC ───────────────────────────────────────────────────────────
const SOCK_PATH = `/tmp/openclaw-dev-${Buffer.from(repoRoot).toString("base64url").slice(0, 16)}.sock`;

function handleCommand(cmd) {
  const c = cmd.trim();
  if (c === "restart-all" || c === "r") { restartAll(); return "ok: restart-all"; }
  if (c === "restart-backend" || c === "b") { restartProc("backend"); return "ok: restart-backend"; }
  if (c === "restart-frontend" || c === "f") { restartProc("frontend"); return "ok: restart-frontend"; }
  if (c === "shutdown" || c === "q") { shutdown(); return "ok: shutdown"; }
  return `unknown command: ${c}`;
}

function setupSocket() {
  try { fs.unlinkSync(SOCK_PATH); } catch { /* no-op */ }
  const server = net.createServer({ allowHalfOpen: false }, (conn) => {
    conn.setEncoding("utf8");
    conn.on("data", (data) => {
      const reply = handleCommand(data);
      syslog(`IPC: ${data.trim()} → ${reply}`);
      conn.end(`${reply}\n`);
    });
  });
  server.listen(SOCK_PATH);
  server.on("error", (err) => syslog(`IPC socket error: ${err.message}`));
}

// ── Entry ─────────────────────────────────────────────────────────────────────
syslog("Dev launcher starting");
syslog(`node: ${NODE}`);
syslog(`PATH: ${childEnv.PATH}`);
printHelp();
syslog(`IPC socket: ${SOCK_PATH}  (use: pnpm dev:ctl <r|b|f|q>)`);

killStaleGatewayProcs();
startProc("backend");
startProc("frontend");
setupKeyboard();
setupSocket();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
