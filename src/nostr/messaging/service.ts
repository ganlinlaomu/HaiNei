import type { NostrEvent } from "nostr-tools";
import { nostrClient } from "@/services/nostrClient";
import { debugLog } from "@/utils/debugLog";
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
  relayResults: Array<{
    relay: string;
    ok: boolean;
    reason?: unknown;
    ts: number;
    eventId: string;
    targetPubkey?: string;
  }>;
}

function eventTarget(event: NostrEvent) {
  return event.tags.find(tag => tag[0] === "p")?.[1];
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
    const targetPubkey = eventTarget(event);
    debugLog("publish", "gift_wrap_publish_start", {
      eventId: event.id.slice(0, 12),
      kind: event.kind,
      target: targetPubkey?.slice(0, 12) || "missing",
      relayCount: relays.length
    });
    const results = await nostrClient.publish(event, relays);
    return results.map(result => {
      debugLog("publish", "gift_wrap_publish_result", {
        eventId: event.id.slice(0, 12),
        target: targetPubkey?.slice(0, 12) || "missing",
        relay: result.relay,
        ok: result.ok
      });
      return { ...result, eventId: event.id, targetPubkey };
    });
  }));
  return batches.flat();
}

export async function sendDirectMessage(options: SendDirectMessageOptions): Promise<PublishedMessage> {
  const encoded = await buildMessageEvents(options);
  debugLog("publish", "message_publish_start", {
    logicalMessageId: encoded.message.id,
    recipients: encoded.message.recipientPubkeys.length,
    giftWraps: encoded.events.length,
    copies: encoded.events.map(event => ({
      eventId: event.id,
      target: eventTarget(event) || "missing",
      role: eventTarget(event) === options.context.senderPubkey ? "sender" : "recipient"
    }))
  }, "info");
  const relayResults = await publishMessageEvents(encoded.events, options.relays);
  const failedEvents = encoded.events.filter(event =>
    !relayResults.some(result => result.eventId === event.id && result.ok)
  );
  if (failedEvents.length > 0) {
    debugLog("publish", "message_publish_failed", {
      failedCopies: failedEvents.map(event => ({
        eventId: event.id.slice(0, 12),
        target: eventTarget(event)?.slice(0, 12) || "missing"
      })),
      copyCount: encoded.events.length,
      relayCount: options.relays.length
    }, "error");
    throw new Error(`消息发布失败：${failedEvents.length}/${encoded.events.length} 个加密副本未被任何 relay 接收`);
  }
  debugLog("publish", "message_publish_success", {
    logicalMessageId: encoded.message.id.slice(0, 12),
    copyCount: encoded.events.length
  }, "info");
  return { ...encoded, relayResults };
}
