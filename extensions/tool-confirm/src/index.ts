/**
 * Tool confirmation extension — intercepts high-risk tools via before_tool_call hook
 * and sends a confirmation request through the channel.
 *
 * When enabled, tools like exec/bash/write/edit require user approval before execution.
 * Approval is collected via channel-specific UI (e.g. Feishu interactive cards).
 */

import crypto from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  requestConfirmation,
  emitConfirmationRequest,
  type ConfirmationRequest,
} from "../../../src/agents/tool-confirmation-bus.js";

/** Default set of tools that require confirmation. */
const DEFAULT_HIGH_RISK_TOOLS = new Set(["exec", "bash", "write", "edit", "apply_patch"]);

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

const plugin = {
  id: "tool-confirm",
  name: "Tool Confirm",
  description: "High-risk tool execution confirmation",

  register(api: OpenClawPluginApi) {
    api.on("before_tool_call", async (event, ctx) => {
      // Read config from plugin config or runtime config
      const cfg = (api.config ?? {}) as ToolConfirmConfig;
      if (!cfg.enabled) return;

      const highRiskTools = cfg.tools
        ? new Set(cfg.tools)
        : DEFAULT_HIGH_RISK_TOOLS;

      if (!highRiskTools.has(event.toolName)) return;

      // Skip if no delivery context (no channel to send confirmation to)
      const delivery = ctx.deliveryContext;
      if (!delivery?.channel) return;

      const confirmId = crypto.randomUUID();

      // Emit a confirmation_request event for channel adapters to render UI
      emitConfirmationRequest({
        confirmId,
        toolName: event.toolName,
        params: event.params,
        sessionKey: ctx.sessionKey,
        deliveryContext: delivery,
      });

      // Wait for user response
      const confirmReq: ConfirmationRequest = {
        id: confirmId,
        toolName: event.toolName,
        params: event.params,
        sessionKey: ctx.sessionKey,
        timeoutMs: cfg.timeoutMs ?? 180_000,
        autoApproveOnTimeout: cfg.autoApproveOnTimeout ?? true,
      };

      const approved = await requestConfirmation(confirmReq);

      if (!approved) {
        return {
          block: true,
          blockReason: `Tool ${event.toolName} rejected by user`,
        };
      }
    });
  },
};

export default plugin;
