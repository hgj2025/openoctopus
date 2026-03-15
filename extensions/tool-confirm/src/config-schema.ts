/**
 * Configuration schema for tool-confirm extension.
 */

export type ToolConfirmConfig = {
  /** Whether tool confirmation is enabled. Default: false */
  enabled?: boolean;
  /** Tools that require confirmation. Default: exec, bash, write, edit, apply_patch */
  tools?: string[];
  /** Timeout in ms before auto-approving. Default: 180000 (3 min) */
  timeoutMs?: number;
  /** Whether to auto-approve on timeout. Default: true */
  autoApproveOnTimeout?: boolean;
};

export const defaultToolConfirmConfig: ToolConfirmConfig = {
  enabled: false,
  tools: ["exec", "bash", "write", "edit", "apply_patch"],
  timeoutMs: 180_000,
  autoApproveOnTimeout: true,
};
