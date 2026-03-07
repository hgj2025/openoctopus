/**
 * MCP transport abstraction for the audit sink.
 *
 * Implementations:
 * - McporterTransport: delegates to the `mcporter` CLI (consistent with existing codebase usage)
 * - StdioTransport: long-lived child process with JSON-RPC 2.0 over stdio (raw MCP protocol)
 *
 * The transport only needs to implement one operation: call a named tool with JSON arguments
 * and return the raw result. Batching, retries, and queuing live in McpAuditSink.
 */
export interface McpTransport {
  /**
   * Call a tool on the remote MCP server.
   * @param toolName - The tool name to invoke (e.g. "submit_audit_log")
   * @param args - JSON-serializable arguments object
   * @throws If the call fails (transport error, timeout, or server-side error)
   */
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;

  /**
   * Gracefully shut down the transport (close connections, wait for in-flight calls).
   */
  close(): Promise<void>;
}

export type McpTransportKind = "mcporter" | "stdio";
