/**
 * Abstraction over coding agent backends (Claude Code, Codex, generic PTY).
 * Session manager depends only on this interface — never on a concrete provider.
 */

export interface ToolRequest {
  /** Unique ID for correlating approval responses */
  id: string;
  /** e.g. "write_file", "bash", "read_file" */
  name: string;
  /** Raw input args from the agent */
  input: Record<string, unknown>;
  /** Human-readable preview of the change (diff, command string, etc.) */
  preview?: string;
}

export type ProgressEventType =
  | "thinking"    // agent is reasoning
  | "tool_start"  // tool invocation beginning
  | "tool_done"   // tool invocation finished
  | "message"     // text output from agent
  | "error";      // non-fatal error or warning

export interface ProgressEvent {
  type: ProgressEventType;
  text: string;
  toolName?: string;
  filePath?: string;
}

export interface CompleteResult {
  success: boolean;
  summary?: string;
  error?: string;
}

export interface StartOptions {
  task: string;
  workdir: string;
  /** Skip tool interception — auto-approve everything (PTY mode default) */
  autoApprove?: boolean;
}

export interface CodingAgentProvider {
  readonly name: string;
  /** True if the provider can intercept tool calls before execution */
  readonly supportsToolInterception: boolean;
  /** True if the provider accepts follow-up messages mid-session */
  readonly supportsFollowUp: boolean;

  /** Start the coding agent. Resolves when the agent exits. */
  start(options: StartOptions): Promise<void>;

  /**
   * Register a tool approval handler.
   * Called before each tool execution; return true to approve, false to reject.
   * Only available when supportsToolInterception is true.
   */
  onToolRequest?(handler: (req: ToolRequest) => Promise<boolean>): void;

  /** Register a progress event handler */
  onProgress(handler: (event: ProgressEvent) => void): void;

  /** Register a completion handler */
  onComplete(handler: (result: CompleteResult) => void): void;

  /** Send a follow-up message or stdin input to the running agent */
  sendFollowUp?(message: string): Promise<void>;

  /** Terminate the agent process */
  terminate(): Promise<void>;
}
