import type { ChannelId } from "../channels/plugins/types.js";
import { normalizeAccountId } from "../routing/session-key.js";

// Pairing API shape used by channel plugins.
type PairingApi = {
  readAllowFromStore: (params: { channel: ChannelId; accountId: string }) => Promise<string[]>;
  upsertPairingRequest: (params: {
    channel: ChannelId;
    accountId: string;
    [key: string]: unknown;
  }) => Promise<unknown>;
};

type PluginRuntimeWithPairing = {
  channel: {
    pairing: PairingApi;
  };
};

type ScopedUpsertInput = Omit<
  Parameters<PairingApi["upsertPairingRequest"]>[0],
  "channel" | "accountId"
>;

export function createScopedPairingAccess(params: {
  core: PluginRuntimeWithPairing;
  channel: ChannelId;
  accountId: string;
}) {
  const resolvedAccountId = normalizeAccountId(params.accountId);
  return {
    accountId: resolvedAccountId,
    readAllowFromStore: () =>
      params.core.channel.pairing.readAllowFromStore({
        channel: params.channel,
        accountId: resolvedAccountId,
      }),
    readStoreForDmPolicy: (provider: ChannelId, accountId: string) =>
      params.core.channel.pairing.readAllowFromStore({
        channel: provider,
        accountId: normalizeAccountId(accountId),
      }),
    upsertPairingRequest: (input: ScopedUpsertInput) =>
      params.core.channel.pairing.upsertPairingRequest({
        channel: params.channel,
        accountId: resolvedAccountId,
        ...input,
      }),
  };
}
