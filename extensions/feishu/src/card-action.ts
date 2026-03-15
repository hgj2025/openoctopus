import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveConfirmation } from "../../../src/agents/tool-confirmation-bus.js";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { resolveApproval } from "./coding-session/index.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  context: {
    open_id: string;
    user_id: string;
    chat_id: string;
  };
};

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;

  // Coding session: approve/reject button clicks bypass normal message dispatch
  if (
    event.action.value &&
    typeof event.action.value === "object" &&
    "coding_session_action" in event.action.value
  ) {
    const v = event.action.value as { coding_session_action: string; session_id?: string; request_id?: string };
    const approved = v.coding_session_action === "approve";
    // session_id is embedded in the button action value by card-renderer
    const sessionId = typeof v.session_id === "string" ? v.session_id : "";
    resolveApproval(sessionId, approved);
    log(
      `feishu[${account.accountId}]: coding session ${v.coding_session_action} from ${event.operator.open_id}`,
    );
    return;
  }

  // Tool confirmation: approve/reject button clicks for high-risk tool execution
  if (
    event.action.value &&
    typeof event.action.value === "object" &&
    "tool_confirm_action" in event.action.value
  ) {
    const v = event.action.value as { tool_confirm_action: string; confirm_id?: string };
    const approved = v.tool_confirm_action === "approve";
    const confirmId = typeof v.confirm_id === "string" ? v.confirm_id : "";
    resolveConfirmation(confirmId, approved);
    log(
      `feishu[${account.accountId}]: tool confirm ${v.tool_confirm_action} from ${event.operator.open_id} confirm_id=${confirmId}`,
    );
    return;
  }

  // Extract action value
  const actionValue = event.action.value;
  let content = "";
  if (typeof actionValue === "object" && actionValue !== null) {
    if ("text" in actionValue && typeof actionValue.text === "string") {
      content = actionValue.text;
    } else if ("command" in actionValue && typeof actionValue.command === "string") {
      content = actionValue.command;
    } else {
      content = JSON.stringify(actionValue);
    }
  } else {
    content = String(actionValue);
  }

  // Construct a synthetic message event
  const messageEvent: FeishuMessageEvent = {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: `card-action-${event.token}`,
      chat_id: event.context.chat_id || event.operator.open_id,
      chat_type: event.context.chat_id ? "group" : "p2p",
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
  };

  log(
    `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
  );

  // Dispatch as normal message
  await handleFeishuMessage({
    cfg,
    event: messageEvent,
    botOpenId: params.botOpenId,
    runtime,
    accountId,
  });
}
