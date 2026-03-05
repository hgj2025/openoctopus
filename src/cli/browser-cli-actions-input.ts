import type { Command } from "commander";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

// Browser action input commands removed (browser module deleted).
export function registerBrowserActionInputCommands(
  _browser: Command,
  _parentOpts: (cmd: Command) => BrowserParentOpts,
): void {}
