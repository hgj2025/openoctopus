/**
 * Feishu card templates for coding sessions.
 *
 * renderApprovalCard — interactive card with Approve/Reject buttons.
 *   Sent as a separate message when the agent needs tool approval.
 */

import type { ToolRequest } from "@openclaw/coding-session";

/** Interactive approval card with Approve / Reject buttons */
export function renderApprovalCard(
  req: ToolRequest,
  sessionId: string,
): Record<string, unknown> {
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: [
        `**工具:** \`${req.name}\``,
        req.preview
          ? `\`\`\`\n${req.preview.slice(0, 600)}\n\`\`\``
          : formatInput(req.input),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    {
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "✅ 批准" },
          type: "primary",
          value: {
            coding_session_action: "approve",
            session_id: sessionId,
            request_id: req.id,
          },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "❌ 拒绝" },
          type: "danger",
          value: {
            coding_session_action: "reject",
            session_id: sessionId,
            request_id: req.id,
          },
        },
      ],
    },
  ];

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "⚠️ 工具审批请求" },
      template: "orange",
    },
    body: { elements },
  };
}

function formatInput(input: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(input, null, 2);
    return s.length > 300 ? s.slice(0, 300) + "\n…" : s;
  } catch {
    return String(input);
  }
}
