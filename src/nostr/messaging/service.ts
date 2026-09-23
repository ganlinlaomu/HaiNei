import type { NostrEvent } from "nostr-tools";
import { nostrClient } from "@/services/nostrClient";
import { debugLog } from "@/utils/debugLog";
import { nip17Adapter, type CanonicalMessage, type EncodeContext } from "./protocol";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";
import type { OutgoingQueueRecord } from "@/db/dexie";
import { triggerGenericPush } from "@/services/pushNotifications";
import { DIRECT_MESSAGE_TYPE } from "@/nostr/messaging/directMessages";

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
  const accountPubkey = options.context.senderPubkey.toLowerCase();
  const accountGeneration = accountGenerations.get(accountPubkey) || 0;
  registerOutgoingPushSigner(accountPubkey, options.context.signEvent);
  const now = Date.now();
  const queued = await outgoingQueueRepository.putIfAbsent({
    accountPubkey,
    outgoingId: encoded.message.id,
    state: "pending",
    message: encoded.message,
    events: encoded.events,
    relays: options.relays,
    attempts: 0,
    createdAt: now,
    updatedAt: now
  });
  if (queued.state === "sent") return queuedResult(queued);
  const published = await publishQueuedOutgoing(accountPubkey, encoded.message.id);
  if ((accountGenerations.get(accountPubkey) || 0) !== accountGeneration) throw new Error("账号已切换");
  return published;
}

export function shouldTriggerGenericPush(tags: string[][] | undefined) {
  const type = tags?.find(tag => tag[0] === "t")?.[1];
  if (type === "like" && tags?.some(tag => tag[0] === "liked" && tag[1] === "false")) return false;
  if (["hainei-profile", "hainei-profile-request", "hainei-tombstone"].includes(type || "")) return false;
  if (tags?.some(tag => tag[0] === "l" && tag[1] === "hainei-friendship")) return type === "request";
  return true;
}

export function pushCategoryForMessage(tags: string[][] | undefined): "message" | "activity" {
  return tags?.some(tag => tag[0] === "t" && tag[1] === DIRECT_MESSAGE_TYPE) ? "message" : "activity";
}

const activePublishes = new Map<string, Promise<PublishedMessage>>();
const accountGenerations = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pushSigners = new Map<string, SendDirectMessageOptions["context"]["signEvent"]>();

export function registerOutgoingPushSigner(
  accountPubkey: string,
  signEvent: SendDirectMessageOptions["context"]["signEvent"]
) {
  pushSigners.set(accountPubkey.toLowerCase(), signEvent);
}

export function cancelOutgoingWorkForAccount(accountPubkey: string) {
  const account = accountPubkey.toLowerCase();
  accountGenerations.set(account, (accountGenerations.get(account) || 0) + 1);
  pushSigners.delete(account);
  const timer = retryTimers.get(account);
  if (timer) clearTimeout(timer);
  retryTimers.delete(account);
}

function scheduleRetry(accountPubkey: string, delay: number) {
  if (retryTimers.has(accountPubkey)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(accountPubkey);
    void retryOutgoingQueue(accountPubkey);
  }, delay);
  (timer as any).unref?.();
  retryTimers.set(accountPubkey, timer);
}

function queuedResult(record: OutgoingQueueRecord): PublishedMessage {
  return {
    message: record.message as CanonicalMessage,
    events: record.events as NostrEvent[],
    relayResults: (record.relayResults || []) as PublishedMessage["relayResults"]
  };
}

export async function publishQueuedOutgoing(accountPubkey: string, outgoingId: string): Promise<PublishedMessage> {
  const key = `${accountPubkey}:${outgoingId}`;
  const existing = activePublishes.get(key);
  if (existing) return existing;
  const task = (async () => {
    const record = await outgoingQueueRepository.get(accountPubkey, outgoingId);
    if (!record) throw new Error("待发送项目不存在");
    if (record.state === "sent") return queuedResult(record);
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (offline) {
      await outgoingQueueRepository.update(accountPubkey, outgoingId, {
        state: "waiting_network", updatedAt: Date.now(), lastError: "offline"
      });
      throw new Error("网络不可用，消息将在联网后重试");
    }
    const attempts = record.attempts + 1;
    await outgoingQueueRepository.update(accountPubkey, outgoingId, { state: "sending", attempts, updatedAt: Date.now() });
    const events = record.events as NostrEvent[];
    let relayResults: PublishedMessage["relayResults"];
    try {
      relayResults = await publishMessageEvents(events, record.relays);
    } catch (error) {
      const state = attempts >= 3 ? "failed" : "waiting_network";
      const delay = Math.min(60_000, 2 ** attempts * 1_000);
      await outgoingQueueRepository.update(accountPubkey, outgoingId, {
        state, nextAttemptAt: Date.now() + delay,
        lastError: error instanceof Error ? error.message : "publish_failed", updatedAt: Date.now()
      });
      if (state === "waiting_network") scheduleRetry(accountPubkey, delay);
      throw error;
    }
    const failedEvents = events.filter(event => !relayResults.some(result => result.eventId === event.id && result.ok));
    if (failedEvents.length) {
      const state = attempts >= 3 ? "failed" : "waiting_network";
      const delay = Math.min(60_000, 2 ** attempts * 1_000);
      await outgoingQueueRepository.update(accountPubkey, outgoingId, {
        state,
        relayResults,
        nextAttemptAt: Date.now() + delay,
        lastError: `${failedEvents.length}/${events.length} copies failed`,
        updatedAt: Date.now()
      });
      if (state === "waiting_network") scheduleRetry(accountPubkey, delay);
      throw new Error(`消息发布失败：${failedEvents.length}/${events.length} 个加密副本未被任何 relay 接收`);
    }
    const sent = await outgoingQueueRepository.update(accountPubkey, outgoingId, {
      state: "sent", relayResults, nextAttemptAt: undefined, lastError: undefined, updatedAt: Date.now()
    });
    const message = record.message as CanonicalMessage;
    const pushSigner = pushSigners.get(accountPubkey);
    if (pushSigner && shouldTriggerGenericPush(message.tags)) {
      const recipients = [...new Set(events.map(eventTarget).filter((value): value is string => !!value))];
      void triggerGenericPush(recipients, accountPubkey, pushSigner, pushCategoryForMessage(message.tags)).catch(() => undefined);
    }
    return queuedResult(sent!);
  })().finally(() => activePublishes.delete(key));
  activePublishes.set(key, task);
  return task;
}

export async function retryOutgoingQueue(accountPubkey: string, includeFailed = false) {
  const records = await outgoingQueueRepository.listRetryable(accountPubkey, includeFailed);
  return Promise.allSettled(records.map(record => publishQueuedOutgoing(accountPubkey, record.outgoingId)));
}

export async function retryFailedOutgoing(accountPubkey: string) {
  return retryOutgoingQueue(accountPubkey, true);
}
