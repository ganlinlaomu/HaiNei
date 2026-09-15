import type { NostrEvent } from "nostr-tools";
import { publish } from "@/nostr/relays";
import { legacy8964Adapter, nip17Adapter, type CanonicalMessage, type EncodeContext } from "./protocol";

export type MessageProtocolPolicy = "nip17" | "legacy";

export interface SendDirectMessageOptions {
  recipientPubkeys: string[];
  content: string;
  replyTo?: string;
  rootId?: string;
  protocol?: MessageProtocolPolicy;
  relays: string[];
  context: EncodeContext;
}

export interface PublishedMessage {
  message: CanonicalMessage;
  events: NostrEvent[];
  relayResults: Array<{ relay: string; ok: boolean; reason?: unknown; ts: number; eventId: string }>;
}

export async function buildMessageEvents(options: Omit<SendDirectMessageOptions, "relays">) {
  const outgoing = {
    recipientPubkeys: options.recipientPubkeys,
    plaintext: options.content,
    replyTo: options.replyTo,
    rootId: options.rootId
  };
  const useLegacy = options.protocol === "legacy" || !options.context.nip44Encrypt;
  const adapter = useLegacy ? legacy8964Adapter : nip17Adapter;
  if (!adapter.encode) throw new Error(`protocol ${adapter.name} cannot encode messages`);
  return adapter.encode(outgoing, options.context);
}

export async function publishMessageEvents(events: NostrEvent[], relays: string[]) {
  const batches = await Promise.all(events.map(async event => {
    const results = await publish(relays, event);
    return results.map(result => ({ ...result, eventId: event.id }));
  }));
  return batches.flat();
}

export async function sendDirectMessage(options: SendDirectMessageOptions): Promise<PublishedMessage> {
  const encoded = await buildMessageEvents(options);
  const relayResults = await publishMessageEvents(encoded.events, options.relays);
  return { ...encoded, relayResults };
}
