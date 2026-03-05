import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelOnboardingAdapter } from "./types.js";

// Built-in onboarding adapters removed — all channels now load via plugins.
const BUILTIN_ONBOARDING_ADAPTERS: ChannelOnboardingAdapter[] = [];

const CHANNEL_ONBOARDING_ADAPTERS = () => {
  const fromRegistry = listChannelPlugins()
    .map((plugin) => (plugin.onboarding ? ([plugin.id, plugin.onboarding] as const) : null))
    .filter((entry): entry is readonly [ChannelChoice, ChannelOnboardingAdapter] => Boolean(entry));

  const fromBuiltins = BUILTIN_ONBOARDING_ADAPTERS.map(
    (adapter) => [adapter.channel, adapter] as const,
  );

  return new Map<ChannelChoice, ChannelOnboardingAdapter>([...fromBuiltins, ...fromRegistry]);
};

export function getChannelOnboardingAdapter(
  channel: ChannelChoice,
): ChannelOnboardingAdapter | undefined {
  return CHANNEL_ONBOARDING_ADAPTERS().get(channel);
}

export function listChannelOnboardingAdapters(): ChannelOnboardingAdapter[] {
  return Array.from(CHANNEL_ONBOARDING_ADAPTERS().values());
}

// Legacy aliases (pre-rename).
export const getProviderOnboardingAdapter = getChannelOnboardingAdapter;
export const listProviderOnboardingAdapters = listChannelOnboardingAdapters;
