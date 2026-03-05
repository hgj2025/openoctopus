// TTS stub — TTS support removed; these are no-op passthroughs.
import type { TtsAutoMode } from "../config/types.tts.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";

export type { TtsAutoMode };

export function resolveTtsConfig(_cfg: OpenClawConfig): { mode?: string; enabled?: boolean } {
  return {};
}

export function normalizeTtsAutoMode(_raw: unknown): TtsAutoMode {
  return "off";
}

export async function maybeApplyTtsToPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
  ttsAuto?: TtsAutoMode;
  [key: string]: unknown;
}): Promise<ReplyPayload> {
  return params.payload;
}

export function buildTtsSystemPromptHint(_cfg: OpenClawConfig): string {
  return "";
}
