import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import {
  db,
  type AccountStateNamespace,
  type BookmarkRecord,
  type FriendshipRecord,
} from "@/db/dexie";
import { accountStateRepository } from "@/repositories/accountStateRepository";
import { deviceStorage } from "@/services/deviceStorage";

export const ACCOUNT_STATE_NAMESPACES: AccountStateNamespace[] = [
  "friendships", "friend_metadata", "own_profile", "settings", "bookmarks",
  "feed_preferences", "read_state", "notification_state",
];
const ACCOUNT_STATE_ACTION = "hainei_account_state";
const SCHEMA_VERSION = 1;

export type AccountStateEnvelope = {
  schemaVersion: number;
  namespace: AccountStateNamespace;
  updatedAt: number;
  data: unknown;
};

export type AccountStateKeys = {
  pkHex: string;
  supportsNip44: boolean;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
};

type RemoteSnapshot = { namespace: AccountStateNamespace; version: number; ciphertext: string; updatedAt: number; deviceId?: string };

function baseUrl() {
  return String(import.meta.env.VITE_HAINEI_WORKER_URL || window.location.origin).trim().replace(/\/+$/, "");
}

async function responseJson(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(String(body?.error || `account_state_http_${response.status}`)) as Error & { status?: number; currentVersion?: number };
    error.status = response.status;
    error.currentVersion = Number(body?.currentVersion || 0);
    throw error;
  }
  return body;
}

async function authenticatedPost(keys: AccountStateKeys, path: string, payload: Record<string, unknown>) {
  const challengeResponse = await fetch(`${baseUrl()}/api/auth/challenge`, { method: "POST" });
  const challengeBody = await responseJson(challengeResponse);
  const challenge = String(challengeBody?.challenge || "");
  const now = Math.floor(Date.now() / 1000);
  const event = await keys.signEvent({
    kind: 27235,
    created_at: now,
    content: "Authorize HaiNei encrypted account state",
    tags: [
      ["t", ACCOUNT_STATE_ACTION],
      ["challenge", challenge],
      ["expiration", String(Math.min(Number(challengeBody?.expiresAt || now + 300), now + 300))],
    ],
  });
  if (event.pubkey.toLowerCase() !== keys.pkHex.toLowerCase()) throw new Error("account_state_identity_mismatch");
  return responseJson(await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, challenge, event }),
  }));
}

function controlTuple(record: FriendshipRecord) {
  return [record.lastControlAt || 0, record.lastControlEventId || ""] as const;
}

export function mergeFriendshipSnapshots(left: FriendshipRecord[] = [], right: FriendshipRecord[] = []) {
  const merged = new Map<string, FriendshipRecord>();
  for (const record of [...left, ...right]) {
    const current = merged.get(record.peerPubkey);
    if (!current) { merged.set(record.peerPubkey, record); continue; }
    const [currentAt, currentId] = controlTuple(current);
    const [nextAt, nextId] = controlTuple(record);
    if (nextAt > currentAt || (nextAt === currentAt && nextId.localeCompare(currentId) > 0)) merged.set(record.peerPubkey, record);
  }
  return [...merged.values()];
}

function mergeByKey<T extends { updatedAt?: number }>(left: T[], right: T[], key: (item: T) => string) {
  const merged = new Map<string, T>();
  for (const item of [...left, ...right]) {
    const current = merged.get(key(item));
    if (!current || Number(item.updatedAt || 0) >= Number(current.updatedAt || 0)) merged.set(key(item), item);
  }
  return [...merged.values()];
}

function mergeReadState(left: any[] = [], right: any[] = []) {
  const merged = new Map<string, any>();
  for (const item of [...left, ...right]) {
    const current = merged.get(item.conversationId);
    const nextTuple = [Number(item.lastReadCreatedAt || 0), String(item.lastReadMessageId || "")];
    const currentTuple = [Number(current?.lastReadCreatedAt || 0), String(current?.lastReadMessageId || "")];
    if (!current || nextTuple[0] > currentTuple[0] || (nextTuple[0] === currentTuple[0] && nextTuple[1] > currentTuple[1])) {
      merged.set(item.conversationId, item);
    }
  }
  return [...merged.values()];
}

export function mergeNamespaceData(namespace: AccountStateNamespace, local: any, remote: any) {
  if (namespace === "friendships") return mergeFriendshipSnapshots(local || [], remote || []);
  if (namespace === "friend_metadata") return mergeByKey(local || [], remote || [], (item: any) => item.pubkey);
  if (namespace === "bookmarks") return mergeByKey(local || [], remote || [], (item: any) => item.messageId);
  if (namespace === "read_state") return mergeReadState(local || [], remote || []);
  if (namespace === "notification_state") {
    const dismissedIds = [...new Set([...(local?.dismissedIds || []), ...(remote?.dismissedIds || [])])];
    const cursor = mergeReadState([
      { conversationId: "notification", ...(local?.readCursor || {}) },
      { conversationId: "notification", ...(remote?.readCursor || {}) },
    ]).at(-1);
    return { dismissedIds, readCursor: cursor ? { lastReadCreatedAt: cursor.lastReadCreatedAt, lastReadMessageId: cursor.lastReadMessageId } : undefined };
  }
  if (namespace === "settings") {
    return {
      relays: mergeByKey(local?.relays || [], remote?.relays || [], (item: any) => item.url),
      mediaServers: mergeByKey(local?.mediaServers || [], remote?.mediaServers || [], (item: any) => item.id),
    };
  }
  if (namespace === "feed_preferences") {
    return {
      hidden: mergeByKey(local?.hidden || [], remote?.hidden || [], (item: any) => item.id),
      muted: mergeByKey(local?.muted || [], remote?.muted || [], (item: any) => item.pubkey),
    };
  }
  return Number(remote?.updatedAt || 0) > Number(local?.updatedAt || 0) ? remote : local;
}

async function decryptSnapshot(keys: AccountStateKeys, snapshot: RemoteSnapshot): Promise<AccountStateEnvelope> {
  const plaintext = await keys.nip44Decrypt(keys.pkHex, snapshot.ciphertext);
  const envelope = JSON.parse(plaintext) as AccountStateEnvelope;
  if (envelope.schemaVersion !== SCHEMA_VERSION || envelope.namespace !== snapshot.namespace) throw new Error("invalid_account_state_envelope");
  return envelope;
}

async function encryptEnvelope(keys: AccountStateKeys, namespace: AccountStateNamespace, data: unknown) {
  const envelope: AccountStateEnvelope = { schemaVersion: SCHEMA_VERSION, namespace, updatedAt: Date.now(), data };
  return keys.nip44Encrypt(keys.pkHex, JSON.stringify(envelope));
}

export async function materializeAccountState(account: string, namespace: AccountStateNamespace, data: any, version: number) {
  if (namespace === "friendships") {
    const existing = await db.accountFriendships.where("accountPubkey").equals(account).toArray();
    await db.accountFriendships.bulkPut(mergeFriendshipSnapshots(existing, data || []).map(record => ({ ...record, accountPubkey: account })));
  } else if (namespace === "friend_metadata") {
    await db.accountFriends.bulkPut((data || []).map((record: any) => ({ ...record, accountPubkey: account })));
  } else if (namespace === "own_profile" && data?.ownerPubkey === account) {
    await db.accountProfiles.put({ ...data, accountPubkey: account });
  } else if (namespace === "settings") {
    deviceStorage.setItem(`nostr_settings_${account}`, JSON.stringify({ version: 3, settings: data, lastSyncTimestamp: Date.now() }));
  } else if (namespace === "bookmarks") {
    await db.accountBookmarks.bulkPut((data || []).map((record: BookmarkRecord) => ({ ...record, accountPubkey: account })));
  } else if (namespace === "feed_preferences") {
    await db.accountMeta.put({ accountPubkey: account, key: "feed_preferences_v2", value: data });
  } else if (namespace === "read_state") {
    await db.conversationReadStates.bulkPut((data || []).map((record: any) => ({ ...record, accountPubkey: account })));
  } else if (namespace === "notification_state") {
    await db.accountMeta.put({ accountPubkey: account, key: "notification_state", value: data });
  }
  await accountStateRepository.put({ accountPubkey: account, namespace, version, data, updatedAt: Date.now() });
}

export async function fetchAndMaterializeAccountState(keys: AccountStateKeys, namespaces = ACCOUNT_STATE_NAMESPACES) {
  const account = keys.pkHex.toLowerCase();
  if (!account || !keys.supportsNip44 || typeof indexedDB === "undefined") {
    return { available: false, restored: [] as AccountStateNamespace[] };
  }
  const response = await authenticatedPost(keys, "/api/account-state/get", { namespaces });
  const restored: AccountStateNamespace[] = [];
  for (const snapshot of (response?.snapshots || []) as RemoteSnapshot[]) {
    try {
      const envelope = await decryptSnapshot(keys, snapshot);
      const local = await accountStateRepository.get(account, snapshot.namespace);
      const data = local ? mergeNamespaceData(snapshot.namespace, local.data, envelope.data) : envelope.data;
      await materializeAccountState(account, snapshot.namespace, data, snapshot.version);
      restored.push(snapshot.namespace);
    } catch (error) {
      console.warn("[account-state] ignored unreadable namespace", snapshot.namespace, error instanceof Error ? error.message : "unknown");
    }
  }
  return { available: true, restored };
}

export async function localNamespaceData(account: string, namespace: AccountStateNamespace): Promise<unknown> {
  if (namespace === "friendships") return db.accountFriendships.where("accountPubkey").equals(account).toArray();
  if (namespace === "friend_metadata") return db.accountFriends.where("accountPubkey").equals(account).toArray();
  if (namespace === "own_profile") return db.accountProfiles.get([account, account]);
  if (namespace === "settings") return JSON.parse(deviceStorage.getItem(`nostr_settings_${account}`) || "null")?.settings || null;
  if (namespace === "bookmarks") return db.accountBookmarks.where("accountPubkey").equals(account).toArray();
  if (namespace === "feed_preferences") return (await db.accountMeta.get([account, "feed_preferences_v2"]))?.value || null;
  if (namespace === "read_state") return db.conversationReadStates.where("accountPubkey").equals(account).toArray();
  if (namespace === "notification_state") return (await db.accountMeta.get([account, "notification_state"]))?.value || null;
  return null;
}

export async function syncAccountStateNamespace(keys: AccountStateKeys, namespace: AccountStateNamespace, deviceId?: string) {
  const account = keys.pkHex.toLowerCase();
  if (!account || !keys.supportsNip44 || typeof indexedDB === "undefined") return false;
  let mirror = await accountStateRepository.get(account, namespace);
  let data = await localNamespaceData(account, namespace);
  for (let attempt = 0; attempt < 2; attempt++) {
    const encrypted = await encryptEnvelope(keys, namespace, data);
    try {
      const result = await authenticatedPost(keys, "/api/account-state/put", {
        namespace, ciphertext: encrypted, expectedVersion: mirror?.version || 0, deviceId,
      });
      await accountStateRepository.put({ accountPubkey: account, namespace, version: Number(result.version), data, updatedAt: Date.now() });
      return true;
    } catch (error: any) {
      if (error?.status !== 409 || attempt > 0) throw error;
      const response = await authenticatedPost(keys, "/api/account-state/get", { namespaces: [namespace] });
      const remote = (response?.snapshots || [])[0] as RemoteSnapshot | undefined;
      if (!remote) { mirror = undefined; continue; }
      const envelope = await decryptSnapshot(keys, remote);
      data = mergeNamespaceData(namespace, data, envelope.data);
      await materializeAccountState(account, namespace, data, remote.version);
      mirror = await accountStateRepository.get(account, namespace);
    }
  }
  return false;
}

const timers = new Map<string, number>();
export function scheduleAccountStateSync(keys: AccountStateKeys, namespace: AccountStateNamespace, deviceId?: string) {
  if (!keys.supportsNip44 || typeof window === "undefined" || typeof indexedDB === "undefined") return;
  const id = `${keys.pkHex}:${namespace}`;
  const existing = timers.get(id);
  if (existing) window.clearTimeout(existing);
  timers.set(id, window.setTimeout(() => {
    timers.delete(id);
    void syncAccountStateNamespace(keys, namespace, deviceId).catch(error => {
      console.warn("[account-state] sync failed", namespace, error instanceof Error ? error.message : "unknown");
    });
  }, 500));
}
