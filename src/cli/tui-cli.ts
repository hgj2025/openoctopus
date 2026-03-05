import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

export function registerTuiCli(program: Command) {
  program
    .command("tui")
    .description("Open a terminal UI connected to the Gateway")
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/tui", "docs.openclaw.ai/cli/tui")}\n`,
    )
    .action(() => {
      defaultRuntime.error("TUI is not available in this build.");
      defaultRuntime.exit(1);
    });
}
