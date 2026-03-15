import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { onConfirmationRequest } from "../../src/agents/tool-confirmation-bus.js";
import { registerFeishuBitableTools } from "./src/bitable.js";
import { feishuPlugin } from "./src/channel.js";
import { registerFeishuChatTools } from "./src/chat.js";
import { registerFeishuDocTools } from "./src/docx.js";
import { registerFeishuDriveTools } from "./src/drive.js";
import { registerFeishuPermTools } from "./src/perm.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { sendCardFeishu } from "./src/send.js";
import { renderToolConfirmCard } from "./src/tool-confirm-card.js";
import { registerFeishuWikiTools } from "./src/wiki.js";

export { monitorFeishuProvider } from "./src/monitor.js";
export {
  sendMessageFeishu,
  sendCardFeishu,
  updateCardFeishu,
  editMessageFeishu,
  getMessageFeishu,
} from "./src/send.js";
export {
  uploadImageFeishu,
  uploadFileFeishu,
  sendImageFeishu,
  sendFileFeishu,
  sendMediaFeishu,
} from "./src/media.js";
export { probeFeishu } from "./src/probe.js";
export {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji,
} from "./src/reactions.js";
export {
  extractMentionTargets,
  extractMessageBody,
  isMentionForwardRequest,
  formatMentionForText,
  formatMentionForCard,
  formatMentionAllForText,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
  type MentionTarget,
} from "./src/mention.js";
export { feishuPlugin } from "./src/channel.js";

const plugin = {
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });
    registerFeishuDocTools(api);
    registerFeishuChatTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);

    // Subscribe to tool confirmation requests and render Feishu approval cards
    onConfirmationRequest(async (event) => {
      if (event.deliveryContext.channel !== "feishu") return;
      const to = event.deliveryContext.to;
      if (!to) return;
      const card = renderToolConfirmCard({
        confirmId: event.confirmId,
        toolName: event.toolName,
        toolParams: event.params,
      });
      try {
        await sendCardFeishu({ cfg: api.config, to, card });
      } catch (err) {
        api.logger.warn(`Failed to send tool confirmation card: ${String(err)}`);
      }
    });
  },
};

export default plugin;
