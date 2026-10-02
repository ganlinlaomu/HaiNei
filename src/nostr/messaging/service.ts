import type { NostrEvent } from "nostr-tools";
import { nostrClient } from "@/services/nostrClient";
import { debugLog } from "@/utils/debugLog";
import { nip17Adapter, type CanonicalMessage, type EncodeContext } from "./protocol";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";
import type { OutgoingQueueRecord, OutgoingRelayResult } from "@/db/dexie";
import { triggerGenericPush } from "@/services/pushNotifications";
import type { PushCategory } from "@/services/pushNotifications";
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
  pushCategory?: PushCategory;
  createdAt?: number;
  onQueued?: (outgoingId: string) => void | Promise<void>;
}

export interface PublishedMessage {
  message: CanonicalMessage;
  events: NostrEvent[];
  relayResults: OutgoingRelayResult[];
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
    tags: options.tags,
    createdAt: options.createdAt
  };
  if (!options.context.nip44Encrypt) throw new Error("当前登录方式不支持 NIP-44，无法发送 NIP-17 消息");
  return nip17Adapter.encode!(outgoing, options.context);
}

export async function publishMessageEvents(
  events: NostrEvent[],
  relays: string[],
  previousResults: OutgoingRelayResult[] = []
) {
  const batches = await Promise.all(events.map(async event => {
    const targetPubkey = eventTarget(event);
    // Once any relay accepted a gift-wrap copy, that copy is terminal. On a
    // retry publish only copies that have never been accepted, preserving the
    // original signed event and avoiding duplicate delivery to other peers.
    if (previousResults.some(result => result.eventId === event.id && result.ok)) return [];
    const pendingRelays = relays.filter(relay => !previousResults.some(
      result => result.eventId === event.id && result.relay === relay && result.ok
    ));
    if (!pendingRelays.length) return [];
    debugLog("publish", "gift_wrap_publish_start", {
      eventId: event.id.slice(0, 12),
      kind: event.kind,
      target: targetPubkey?.slice(0, 12) || "missing",
      relayCount: pendingRelays.length
    });
    const results = await nostrClient.publish(event, pendingRelays);
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

function mergeRelayResults(previous: OutgoingRelayResult[], current: OutgoingRelayResult[]) {
  const merged = new Map<string, OutgoingRelayResult>();
  for (const result of [...previous, ...current]) {
    const key = `${result.eventId}\u0000${result.relay}`;
    const existing = merged.get(key);
    // A recorded acknowledgement is terminal and cannot be downgraded by a
    // later timeout or disconnect report.
    if (!existing?.ok || result.ok) merged.set(key, result);
  }
  return [...merged.values()];
}

export async function sendDirectMessage(options: SendDirectMessageOptions): Promise<PublishedMessage> {
  const encoded = await buildMessageEvents(options);
  const accountPubkey = options.context.senderPubkey.toLowerCase();
  const accountGeneration = accountGenerations.get(accountPubkey) || 0;
  registerOutgoingPushSigner(accountPubkey, options.context.signEvent);
  const now = Date.now();
  await outgoingQueueRepository.putIfAbsent({
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
  await options.onQueued?.(encoded.message.id);
  const published = await publishQueuedOutgoing(accountPubkey, encoded.message.id, options.pushCategory);
  if ((accountGenerations.get(accountPubkey) || 0) !== accountGeneration) throw new Error("账号已切换");
  return published;
}

export function shouldTriggerGenericPush(tags: string[][] | undefined) {
  return tags?.some(tag => tag[0] === "t" && tag[1] === DIRECT_MESSAGE_TYPE) === true;
}

export function pushCategoryForMessage(tags: string[][] | undefined): "message" | null {
  return shouldTriggerGenericPush(tags) ? "message" : null;
}

const activePublishes = new Map<string, Promise<PublishedMessage>>();
const accountGenerations = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryDeadlines = new Map<string, number>();
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
  retryDeadlines.delete(account);
}

function scheduleRetry(accountPubkey: string, delay: number) {
  const account = accountPubkey.toLowerCase();
  const normalizedDelay = Math.max(0, Math.floor(delay));
  const dueAt = Date.now() + normalizedDelay;
  const existingDueAt = retryDeadlines.get(account);
  if (existingDueAt !== undefined && existingDueAt <= dueAt) return;
  const existing = retryTimers.get(account);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    retryTimers.delete(account);
    retryDeadlines.delete(account);
    void retryOutgoingQueue(account);
  }, normalizedDelay);
  (timer as any).unref?.();
  retryTimers.set(account, timer);
  retryDeadlines.set(account, dueAt);
}

function queuedResult(record: OutgoingQueueRecord): PublishedMessage {
  return {
    message: record.message as CanonicalMessage,
    events: record.events as NostrEvent[],
    relayResults: (record.relayResults || []) as PublishedMessage["relayResults"]
  };
}

export async function publishQueuedOutgoing(accountPubkey: string, outgoingId: string, _pushCategory?: PushCategory): Promise<PublishedMessage> {
  const key = `${accountPubkey}:${outgoingId}`;
  const existing = activePublishes.get(key);
  if (existing) return existing;
  const task = (async () => {
    const record = await outgoingQueueRepository.get(accountPubkey, outgoingId);
    if (!record) throw new Error("待发送项目不存在");
    if (record.state === "sent") {
      await deliverQueuedPush(record);
      return queuedResult(record);
    }
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
      const previousResults = record.relayResults || [];
      const currentResults = await publishMessageEvents(events, record.relays, previousResults);
      relayResults = mergeRelayResults(previousResults, currentResults);
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
    const recipientEvents = events.filter(event => eventTarget(event) !== accountPubkey);
    const requiredEvents = recipientEvents.length ? recipientEvents : events;
    const failedRequiredEvents = requiredEvents.filter(event => !relayResults.some(result => result.eventId === event.id && result.ok));
    if (failedRequiredEvents.length) {
      const state = attempts >= 3 ? "failed" : "waiting_network";
      const delay = Math.min(60_000, 2 ** attempts * 1_000);
      await outgoingQueueRepository.update(accountPubkey, outgoingId, {
        state,
        relayResults,
        nextAttemptAt: Date.now() + delay,
        lastError: `${failedRequiredEvents.length}/${requiredEvents.length} recipient copies failed`,
        updatedAt: Date.now()
      });
      if (state === "waiting_network") scheduleRetry(accountPubkey, delay);
      throw new Error(`消息发布失败：${failedRequiredEvents.length}/${requiredEvents.length} 个收件人副本未被任何 relay 接收`);
    }
    const needsPush = shouldTriggerGenericPush((record.message as CanonicalMessage).tags);
    const sent = await outgoingQueueRepository.update(accountPubkey, outgoingId, {
      state: "sent", relayResults, nextAttemptAt: undefined, lastError: undefined, updatedAt: Date.now(),
      ...(needsPush ? { pushState: "pending", pushAttempts: 0, pushExpiresAt: Date.now() + 24 * 60 * 60 * 1000 } : {}),
    });
    if (sent) await deliverQueuedPush(sent);
    return queuedResult(sent!);
  })().finally(() => activePublishes.delete(key));
  activePublishes.set(key, task);
  return task;
}

async function deliverQueuedPush(record: OutgoingQueueRecord) {
  if (record.pushState !== "pending" || (record.pushExpiresAt || 0) <= Date.now()) return;
  const signer = pushSigners.get(record.accountPubkey);
  // Keep pending work on disk until the account is unlocked again.
  if (!signer || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  if ((record.pushNextAttemptAt || 0) > Date.now()) {
    scheduleRetry(record.accountPubkey, record.pushNextAttemptAt! - Date.now());
    return;
  }
  const attempts = (record.pushAttempts || 0) + 1;
  const delay = Math.min(15 * 60_000, 2 ** Math.min(attempts, 10) * 1_000);
  await outgoingQueueRepository.update(record.accountPubkey, record.outgoingId, {
    pushAttempts: attempts, pushNextAttemptAt: Date.now() + delay,
  });
  try {
    const recipients = [...new Set((record.events as NostrEvent[]).map(eventTarget).filter((value): value is string => !!value))];
    await triggerGenericPush(recipients, record.accountPubkey, signer, "message", (record.message as CanonicalMessage).id);
    await outgoingQueueRepository.update(record.accountPubkey, record.outgoingId, {
      pushState: "accepted", pushNextAttemptAt: undefined,
    });
  } catch (error) {
    debugLog("system", "push_trigger_failed", {
      reason: error instanceof Error ? error.message : "unknown_error",
    }, "warn");
    if (pushSigners.has(record.accountPubkey)) scheduleRetry(record.accountPubkey, delay);
  }
}

export async function retryOutgoingQueue(accountPubkey: string, includeFailed = false) {
  const records = await outgoingQueueRepository.listRetryable(accountPubkey, includeFailed);
  return Promise.allSettled(records.map(record => publishQueuedOutgoing(accountPubkey, record.outgoingId)));
}

export async function retryFailedOutgoing(accountPubkey: string) {
  return retryOutgoingQueue(accountPubkey, true);
}
