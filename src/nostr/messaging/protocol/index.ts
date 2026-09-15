import type { NostrEvent } from "nostr-tools";
import { legacy8964Adapter, legacy8965Adapter } from "./legacy";
import { nip04Adapter } from "./nip04";
import { nip17Adapter } from "./nip17";
import type { CanonicalMessage, DecodeContext, MessageProtocolAdapter } from "./types";

export * from "./types";
export * from "./legacy";
export * from "./nip04";
export * from "./nip17";
export * from "./nip44";

export const messageProtocols: readonly MessageProtocolAdapter[] = [
  nip17Adapter,
  nip04Adapter,
  legacy8964Adapter,
  legacy8965Adapter
];

export async function decodeMessageEvent(event: NostrEvent, context: DecodeContext): Promise<CanonicalMessage | null> {
  const adapter = messageProtocols.find(candidate => candidate.canDecode(event));
  if (!adapter) return null;
  try {
    return await adapter.decode(event, context);
  } catch {
    return null;
  }
}
