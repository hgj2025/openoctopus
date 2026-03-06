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
  core: PluginRuntimeWithPairing | { channel: Record<string, unknown> };
  channel: ChannelId;
  accountId: string;
}) {
  const resolvedAccountId = normalizeAccountId(params.accountId);
  // channel.pairing may be absent if the runtime no longer includes it;
  // degrade gracefully so callers receive empty lists rather than crashing.
  const pairingApi: PairingApi | undefined = (
    params.core as Partial<PluginRuntimeWithPairing>
  ).channel?.pairing;
  return {
    accountId: resolvedAccountId,
    readAllowFromStore: (): Promise<string[]> => {
      if (!pairingApi) return Promise.resolve([]);
      return pairingApi.readAllowFromStore({
        channel: params.channel,
        accountId: resolvedAccountId,
      });
    },
    readStoreForDmPolicy: (provider: ChannelId, accountId: string): Promise<string[]> => {
      if (!pairingApi) return Promise.resolve([]);
      return pairingApi.readAllowFromStore({
        channel: provider,
        accountId: normalizeAccountId(accountId),
      });
    },
    upsertPairingRequest: (input: ScopedUpsertInput): Promise<unknown> => {
      if (!pairingApi) return Promise.resolve({ code: null, created: false });
      return pairingApi.upsertPairingRequest({
        channel: params.channel,
        accountId: resolvedAccountId,
        ...input,
      });
    },
  };
}
