import type { OutboundSendDeps } from "../infra/outbound/deliver.js";

export type CliDeps = Record<string, never>;

export function createDefaultDeps(): CliDeps {
  return {};
}

export function createOutboundSendDeps(_deps: CliDeps): OutboundSendDeps {
  return {};
}
