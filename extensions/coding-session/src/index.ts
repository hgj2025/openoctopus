export type { CodingAgentProvider, ToolRequest, ProgressEvent, CompleteResult, StartOptions } from "./provider/interface.js";
export type { ChannelAdapter, SessionCardState, ProgressLogEntry } from "./channel/interface.js";
export type { CodingSession } from "./session-manager.js";

export { ClaudeCodeCliProvider } from "./provider/claude-code-cli.js";
export { AidenCliProvider } from "./provider/aiden-cli.js";
export { PTYGenericProvider } from "./provider/pty-generic.js";
export { resolveProvider } from "./provider/registry.js";

export { startCodingSession, getSession, removeSession, routeFollowUp } from "./session-manager.js";
