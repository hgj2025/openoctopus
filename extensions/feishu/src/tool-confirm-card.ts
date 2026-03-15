/**
 * Feishu interactive card for tool execution confirmation.
 *
 * Renders an approval card with tool name, parameter preview,
 * and Approve/Reject buttons. Button values embed the confirm_id
 * for resolution via the tool-confirmation-bus.
 */

/** Render a tool confirmation card for Feishu. */
export function renderToolConfirmCard(params: {
  confirmId: string;
  toolName: string;
  toolParams: Record<string, unknown>;
}): Record<string, unknown> {
  const { confirmId, toolName, toolParams } = params;

  const elements: unknown[] = [
    {
      tag: "markdown",
      content: [
        `**工具:** \`${toolName}\``,
        formatParams(toolParams),
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
            tool_confirm_action: "approve",
            confirm_id: confirmId,
          },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "❌ 拒绝" },
          type: "danger",
          value: {
            tool_confirm_action: "reject",
            confirm_id: confirmId,
          },
        },
      ],
    },
  ];

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "⚠️ 工具执行确认" },
      template: "orange",
    },
    body: { elements },
  };
}

function formatParams(params: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(params, null, 2);
    const truncated = s.length > 600 ? s.slice(0, 600) + "\n…" : s;
    return `\`\`\`\n${truncated}\n\`\`\``;
  } catch {
    return String(params);
  }
}
