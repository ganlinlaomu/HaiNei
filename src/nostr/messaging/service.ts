import type { NostrEvent } from "nostr-tools";
import { publish } from "@/nostr/relays";
import { nip17Adapter, type CanonicalMessage, type EncodeContext } from "./protocol";

export type MessageProtocolPolicy = "nip17";

export interface SendDirectMessageOptions {
  recipientPubkeys: string[];
  content: string;
  replyTo?: string;
  rootId?: string;
  tags?: string[][];
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
    rootId: options.rootId,
    tags: options.tags
  };
  if (!options.context.nip44Encrypt) throw new Error("当前登录方式不支持 NIP-44，无法发送 NIP-17 消息");
  return nip17Adapter.encode!(outgoing, options.context);
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
  const failedEvents = encoded.events.filter(event =>
    !relayResults.some(result => result.eventId === event.id && result.ok)
  );
  if (failedEvents.length > 0) {
    throw new Error(`消息发布失败：${failedEvents.length}/${encoded.events.length} 个加密副本未被任何 relay 接收`);
  }
  return { ...encoded, relayResults };
}
