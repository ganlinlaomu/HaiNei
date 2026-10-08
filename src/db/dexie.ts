import { installLocalVault } from "@/services/localVault";
import Dexie, { type Table, type Transaction } from "dexie";
import { legacyBrowserStorageForMigration } from "@/services/legacyStorageAccess";
import type { NostrEvent } from "nostr-tools";

export const APP_VERSION = "0.1.35";
export const DB_VERSION = 19;
export const DATABASE_NAME = "closed_community_db";

export type DBMessage = {
  id: string;
  pubkey: string;
  content?: string;
  created_at: number;
};

export type DBFriend = {
  pubkey: string;
  name?: string;
  group?: string;
  groups?: string[];
  note?: string;
  updatedAt?: number;
  deleted?: boolean;
};

export type DBMeta = {
  key: string;
  value?: unknown;
  [key: string]: unknown;
};

export type DBImageCache = {
  // Legacy v2 plaintext image-cache row. Current application code never writes it.
  url: string;
  blob: Blob;
  timestamp: number;
  mime: string;
};

export type AccountMessageRecord = DBMessage & { accountPubkey: string };
export type AccountFriendRecord = DBFriend & { accountPubkey: string };
export type AccountMetaRecord = DBMeta & { accountPubkey: string };
export type AccountImageCacheRecord = {
  accountPubkey: string;
  // Legacy-compatible column name: this stores only the SHA-256 cache id,
  // never the key-bearing media reference itself.
  url: string;
  sealedBytes: ArrayBuffer;
  iv: ArrayBuffer;
  mime: string;
  size: number;
  timestamp: number;
  lastAccess: number;
  version: 1;
};

export type SyncedMessageRecord = {
  accountPubkey: string;
  id: string;
  senderPubkey: string;
  recipientPubkeys: string[];
  conversationId: string;
  messageClass?: "direct" | "other";
  plaintext?: string;
  ciphertext?: string;
  createdAt: number;
  protocol: string;
  transportKind: number;
  transportEventIds: string[];
  rumorId?: string;
  replyTo?: string;
  rootId?: string;
  tags?: string[][];
  firstSeenAt: number;
  lastSeenAt: number;
};

export type ConversationStateRecord = {
  visibleUnreadCache?: { policy: string; count: number };
  unreadCache?: { cursor: string; count: number; directCount: number };
  accountPubkey: string;
  conversationId: string;
  lastMessageId: string;
  lastMessageAt: number;
  lastMessageSenderPubkey: string;
  updatedAt: number;
};

export type ConversationReadStateRecord = {
  accountPubkey: string;
  conversationId: string;
  lastReadMessageId?: string;
  lastReadCreatedAt?: number;
  updatedAt: number;
};

export type RelaySyncStateRecord = {
  url: string;
  connected: boolean;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  lastEOSEAt?: number;
  lastEventCreatedAt?: number;
  lastSuccessfulCatchupAt?: number;
  /** Relay-local resume cursor for an incomplete initial history repair. */
  historyBackfillUntil?: number;
  /** Marks that this relay independently reached the end of initial history. */
  historyBackfillCompletedAt?: number;
};

export type MessageSyncStateRecord = {
  accountPubkey: string;
  lastSuccessfulSyncAt?: number;
  /** Marks that this device has started its one-time initial history repair. */
  historyBackfillStartedAt?: number;
  /** Marks completion of the bounded, one-time history repair for this device. */
  historyBackfillCompletedAt?: number;
  /** Oldest gift-wrap timestamp reached by an incomplete bounded history repair. */
  historyBackfillUntil?: number;
  historyBackfillRelaySignature?: string;
  highWatermarkCreatedAt?: number;
  lastRealtimeConnectedAt?: number;
  lastCatchupCompletedAt?: number;
  status: "idle" | "connecting" | "catching-up" | "live" | "offline" | "error";
  relayStates: Record<string, RelaySyncStateRecord>;
};

export type DecryptedEventRecord = {
  accountPubkey: string;
  eventId: string;
  message: unknown;
  decryptedAt: number;
};

export type DeferredAuthorizationMessageRecord = {
  accountPubkey: string;
  id: string;
  createdAt: number;
  message: unknown;
  metadata: {
    source: string;
    relayUrl?: string;
  };
  deferredAt: number;
};

export type FriendshipState = "outgoing_pending" | "incoming_pending" | "accepted" | "removed" | "rejected" | "cancelled" | "blocked";

export type FriendshipAcceptedWindow = {
  acceptedAt: number;
  acceptedEventId: string;
  endedAt?: number;
  endedEventId?: string;
};

export type FriendshipRecord = {
  accountPubkey: string;
  peerPubkey: string;
  state: FriendshipState;
  requestEventId?: string;
  acceptedEventId?: string;
  requestedAt?: number;
  acceptedAt?: number;
  acceptedWindows?: FriendshipAcceptedWindow[];
  lastAction?: "request" | "accept" | "reject" | "remove" | "cancel";
  lastControlAt?: number;
  lastControlEventId?: string;
  updatedAt: number;
};

export type HaiNeiProfile = {
  ownerPubkey: string;
  nickname?: string;
  bio?: string;
  avatar?: string;
  updatedAt: number;
};

export type AccountProfileRecord = HaiNeiProfile & { accountPubkey: string };

export type OutgoingQueueState = "pending" | "sending" | "waiting_network" | "failed" | "sent";
export type OutgoingRelayResult = {
  relay: string;
  ok: boolean;
  reason?: unknown;
  ts: number;
  eventId: string;
  targetPubkey?: string;
};
export type OutgoingEventRoute = {
  eventId: string;
  targetPubkey: string;
  relays: string[];
  source: "nip17-10050" | "own-10050" | "legacy-fallback";
  resolvedAt: number;
};
export type OutgoingQueueRecord = {
  accountPubkey: string;
  outgoingId: string;
  state: OutgoingQueueState;
  message: unknown;
  events: unknown[];
  relays: string[];
  /** Per-gift-wrap route. Absent on v16 rows, which continue using `relays`. */
  eventRoutes?: OutgoingEventRoute[];
  /** New messages must finish discovery before any durable retry publishes. */
  dmRelayRoutesPending?: boolean;
  relayResults?: OutgoingRelayResult[];
  // Separate from relay delivery so a suspended PWA can retry the push request.
  pushState?: "pending" | "accepted";
  pushAttempts?: number;
  pushNextAttemptAt?: number;
  pushExpiresAt?: number;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

export type OutgoingDmTaskState = "uploading" | "sending" | "sent" | "upload_failed" | "send_failed";
export type PreparedEncryptedImage = {
  encryptedBytes: ArrayBuffer;
  encryptedName: string;
  previewBytes: ArrayBuffer;
  mime: string;
  iv: string;
  key: string;
  width: number;
  height: number;
};
export type PreparedEncryptedAudio = {
  encryptedBytes: ArrayBuffer;
  encryptedName: string;
  mime: string;
  iv: string;
  key: string;
  duration: number;
  size: number;
};
export type OutgoingDmTaskRecord = {
  accountPubkey: string;
  localId: string;
  peerPubkey: string;
  text: string;
  /** Opt-in disappearing text message setting. */
  burnAfterSeconds?: 10 | 30 | 60;
  replyTo?: string;
  imageBytes?: ArrayBuffer;
  imageName?: string;
  imageType?: string;
  preparedImage?: PreparedEncryptedImage;
  mediaType?: "image" | "audio";
  preparedAudio?: PreparedEncryptedAudio;
  audioMime?: string;
  audioDuration?: number;
  audioSize?: number;
  state: OutgoingDmTaskState;
  uploadedRef?: string;
  outgoingId?: string;
  canonicalMessageId?: string;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
};

// Only account/id/timestamps are indexed; the private content is encrypted by localVault.
export type PrivateSpaceTask = { id: string; text: string; done: boolean };
export type PrivateSpaceRecord = {
  accountPubkey: string;
  id: string;
  kind: "note" | "todo";
  title: string;
  body: string;
  tasks: PrivateSpaceTask[];
  pinned: boolean;
  archivedAt?: number;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
  revision: number;
  /** Last Worker CAS version we have applied or published. */
  cloudVersion?: number;
  /** Local revision whose contents were last confirmed remotely. */
  syncedRevision?: number;
};

export type BookmarkRecord = {
  accountPubkey: string;
  messageId: string;
  createdAt: number;
  updatedAt?: number;
  deleted?: boolean;
};

export type DeviceKeyValueRecord = { key: string; value: string; updatedAt: number };
export type AccountStateNamespace =
  | "friendships" | "friend_metadata" | "own_profile" | "settings"
  | "bookmarks" | "feed_preferences" | "read_state" | "notification_state";
export type AccountStateMirrorRecord = {
  accountPubkey: string;
  namespace: AccountStateNamespace;
  version: number;
  data: unknown;
  updatedAt: number;
};

export type ReplaceableEventOutboxRecord = {
  accountPubkey: string;
  key: string;
  event: NostrEvent;
  relays: string[];
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

export type DmRelayDirectoryRecord = {
  accountPubkey: string;
  ownerPubkey: string;
  relays: string[];
  eventId?: string;
  eventCreatedAt?: number;
  fetchedAt: number;
  expiresAt: number;
  publishedAt?: number;
  source: "own" | "nip17" | "negative";
  sourceRelays?: string[];
};

const ACCOUNT_SCOPED_KEY_PATTERNS = [
  /^nostr_(?:inbox|outbox|friends|notifications|settings)_([0-9a-f]{64})$/i,
  /^interactions_([0-9a-f]{64})$/i,
  /^home_lastSeenCreatedAt_([0-9a-f]{64})$/i,
  /^backfill_breakpoint_(?:messages|interactions)_([0-9a-f]{64})$/i,
  /^encrypted_sk_([0-9a-f]{64})$/i,
];

/** Resolve ownership only when browser storage proves there is one account. */
export function resolveUnambiguousLegacyAccount(storage: Storage | undefined = legacyBrowserStorageForMigration()): string | null {
  if (!storage) return null;
  const accounts = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)) {
      accounts.add(value.toLowerCase());
    }
  };

  try {
    add(storage.getItem("pkHex"));
    const registered = JSON.parse(storage.getItem("nostr_registered_accounts") || "[]");
    if (Array.isArray(registered)) registered.forEach(add);
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i) || "";
      for (const pattern of ACCOUNT_SCOPED_KEY_PATTERNS) {
        const match = key.match(pattern);
        if (match) add(match[1]);
      }
    }
  } catch (e) {
    console.warn("[storage] unable to determine legacy IndexedDB owner", e);
    return null;
  }

  return accounts.size === 1 ? [...accounts][0] : null;
}

async function migrateLegacyPrivateData(transaction: Transaction) {
  const accountPubkey = resolveUnambiguousLegacyAccount();
  if (!accountPubkey) {
    console.warn("[storage] legacy IndexedDB ownership is ambiguous; legacy private rows were quarantined");
    return;
  }

  try {
    const messages = await transaction.table<DBMessage>("messages").toArray();
    const friends = await transaction.table<DBFriend>("friends").toArray();
    const meta = await transaction.table<DBMeta>("meta").toArray();
    const imageCache = await transaction.table<DBImageCache>("imageCache").toArray();

    await transaction.table<AccountMessageRecord>("accountMessages").bulkPut(
      messages.map(record => ({ ...record, pubkey: record.pubkey.toLowerCase(), accountPubkey }))
    );
    await transaction.table<AccountFriendRecord>("accountFriends").bulkPut(
      friends.map(record => ({ ...record, pubkey: record.pubkey.toLowerCase(), accountPubkey }))
    );
    await transaction.table<AccountMetaRecord>("accountMeta").bulkPut(
      meta.map(record => ({ ...record, accountPubkey }))
    );
    await transaction.table<DBImageCache & { accountPubkey: string }>("accountImageCache").bulkPut(
      imageCache.map(record => ({ ...record, accountPubkey }))
    );
    console.info(`[storage] migrated legacy IndexedDB rows account=${accountPubkey.slice(0, 8)}`);
  } catch (e) {
    console.warn("[storage] legacy IndexedDB migration skipped after an error", e);
  }
}

export class HaiNeiDatabase extends Dexie {
  // v1/v2 legacy tables are retained but no application repository reads them.
  messages!: Table<DBMessage, string>;
  friends!: Table<DBFriend, string>;
  meta!: Table<DBMeta, string>;
  imageCache!: Table<DBImageCache, string>;

  accountMessages!: Table<AccountMessageRecord, [string, string]>;
  accountFriends!: Table<AccountFriendRecord, [string, string]>;
  accountMeta!: Table<AccountMetaRecord, [string, string]>;
  accountImageCache!: Table<AccountImageCacheRecord, [string, string]>;
  syncedMessages!: Table<SyncedMessageRecord, [string, string]>;
  conversationStates!: Table<ConversationStateRecord, [string, string]>;
  conversationReadStates!: Table<ConversationReadStateRecord, [string, string]>;
  messageSyncStates!: Table<MessageSyncStateRecord, string>;
  decryptedEvents!: Table<DecryptedEventRecord, [string, string]>;
  deferredAuthorizationMessages!: Table<DeferredAuthorizationMessageRecord, [string, string]>;
  accountFriendships!: Table<FriendshipRecord, [string, string]>;
  accountProfiles!: Table<AccountProfileRecord, [string, string]>;
  outgoingQueue!: Table<OutgoingQueueRecord, [string, string]>;
  outgoingDmTasks!: Table<OutgoingDmTaskRecord, [string, string]>;
  accountBookmarks!: Table<BookmarkRecord, [string, string]>;
  accountNotes!: Table<PrivateSpaceRecord, [string, string]>;
  deviceKeyValues!: Table<DeviceKeyValueRecord, string>;
  accountStateMirrors!: Table<AccountStateMirrorRecord, [string, AccountStateNamespace]>;
  replaceableEventOutbox!: Table<ReplaceableEventOutboxRecord, [string, string]>;
  dmRelayDirectory!: Table<DmRelayDirectoryRecord, [string, string]>;

  constructor(name = DATABASE_NAME, requireVault = import.meta.env.MODE !== "test") {
    super(name);

    this.version(1).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key"
    });

    this.version(2).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp"
    });

    this.version(3).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]"
    }).upgrade(migrateLegacyPrivateData);

    // PR4 is additive: old rows remain untouched and are lazily mirrored through
    // the account-scoped message repository when an account starts syncing.
    this.version(4).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]",
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+createdAt], [accountPubkey+senderPubkey]",
      conversationStates: "[accountPubkey+conversationId], accountPubkey, [accountPubkey+lastMessageAt]",
      conversationReadStates: "[accountPubkey+conversationId], accountPubkey",
      messageSyncStates: "accountPubkey"
    });

    // Account-scoped NIP-17 decode cache. This is additive and never clears v4 data.
    this.version(5).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]",
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+createdAt], [accountPubkey+senderPubkey]",
      conversationStates: "[accountPubkey+conversationId], accountPubkey, [accountPubkey+lastMessageAt]",
      conversationReadStates: "[accountPubkey+conversationId], accountPubkey",
      messageSyncStates: "accountPubkey",
      decryptedEvents: "[accountPubkey+eventId], accountPubkey, [accountPubkey+decryptedAt]"
    });

    this.version(6).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]",
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+createdAt], [accountPubkey+senderPubkey]",
      conversationStates: "[accountPubkey+conversationId], accountPubkey, [accountPubkey+lastMessageAt]",
      conversationReadStates: "[accountPubkey+conversationId], accountPubkey",
      messageSyncStates: "accountPubkey",
      decryptedEvents: "[accountPubkey+eventId], accountPubkey, [accountPubkey+decryptedAt]",
      accountFriendships: "[accountPubkey+peerPubkey], accountPubkey, [accountPubkey+state], [accountPubkey+updatedAt]"
    });

    this.version(7).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]",
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+createdAt], [accountPubkey+senderPubkey]",
      conversationStates: "[accountPubkey+conversationId], accountPubkey, [accountPubkey+lastMessageAt]",
      conversationReadStates: "[accountPubkey+conversationId], accountPubkey",
      messageSyncStates: "accountPubkey",
      decryptedEvents: "[accountPubkey+eventId], accountPubkey, [accountPubkey+decryptedAt]",
      accountFriendships: "[accountPubkey+peerPubkey], accountPubkey, [accountPubkey+state], [accountPubkey+updatedAt]",
      accountProfiles: "[accountPubkey+ownerPubkey], accountPubkey, [accountPubkey+updatedAt]"
    });

    this.version(8).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]",
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+createdAt], [accountPubkey+senderPubkey]",
      conversationStates: "[accountPubkey+conversationId], accountPubkey, [accountPubkey+lastMessageAt]",
      conversationReadStates: "[accountPubkey+conversationId], accountPubkey",
      messageSyncStates: "accountPubkey",
      decryptedEvents: "[accountPubkey+eventId], accountPubkey, [accountPubkey+decryptedAt]",
      accountFriendships: "[accountPubkey+peerPubkey], accountPubkey, [accountPubkey+state], [accountPubkey+updatedAt]",
      accountProfiles: "[accountPubkey+ownerPubkey], accountPubkey, [accountPubkey+updatedAt]",
      outgoingQueue: "[accountPubkey+outgoingId], accountPubkey, [accountPubkey+state], [accountPubkey+nextAttemptAt]"
    });

    this.version(9).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]",
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+createdAt], [accountPubkey+senderPubkey]",
      conversationStates: "[accountPubkey+conversationId], accountPubkey, [accountPubkey+lastMessageAt]",
      conversationReadStates: "[accountPubkey+conversationId], accountPubkey",
      messageSyncStates: "accountPubkey",
      decryptedEvents: "[accountPubkey+eventId], accountPubkey, [accountPubkey+decryptedAt]",
      accountFriendships: "[accountPubkey+peerPubkey], accountPubkey, [accountPubkey+state], [accountPubkey+updatedAt]",
      accountProfiles: "[accountPubkey+ownerPubkey], accountPubkey, [accountPubkey+updatedAt]",
      outgoingQueue: "[accountPubkey+outgoingId], accountPubkey, [accountPubkey+state], [accountPubkey+nextAttemptAt]",
      accountBookmarks: "[accountPubkey+messageId], accountPubkey, [accountPubkey+createdAt]"
    });

    this.version(10).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]",
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+createdAt], [accountPubkey+senderPubkey]",
      conversationStates: "[accountPubkey+conversationId], accountPubkey, [accountPubkey+lastMessageAt]",
      conversationReadStates: "[accountPubkey+conversationId], accountPubkey",
      messageSyncStates: "accountPubkey",
      decryptedEvents: "[accountPubkey+eventId], accountPubkey, [accountPubkey+decryptedAt]",
      accountFriendships: "[accountPubkey+peerPubkey], accountPubkey, [accountPubkey+state], [accountPubkey+updatedAt]",
      accountProfiles: "[accountPubkey+ownerPubkey], accountPubkey, [accountPubkey+updatedAt]",
      outgoingQueue: "[accountPubkey+outgoingId], accountPubkey, [accountPubkey+state], [accountPubkey+nextAttemptAt]",
      accountBookmarks: "[accountPubkey+messageId], accountPubkey, [accountPubkey+createdAt]"
    }).upgrade(async transaction => {
      await transaction.table<FriendshipRecord>("accountFriendships").toCollection().modify(record => {
        const action = record.state === "accepted" ? "accept"
          : record.state === "incoming_pending" || record.state === "outgoing_pending" ? "request"
            : undefined;
        const eventId = action === "accept" ? record.acceptedEventId : record.requestEventId;
        const controlAt = action === "accept" ? record.acceptedAt : record.requestedAt;
        if (action) record.lastAction = action;
        if (eventId) record.lastControlEventId = eventId;
        if (controlAt) record.lastControlAt = controlAt;
        if (record.state === "accepted" && record.acceptedAt && record.acceptedEventId && !record.acceptedWindows?.length) {
          record.acceptedWindows = [{ acceptedAt: record.acceptedAt, acceptedEventId: record.acceptedEventId }];
        }
      });
    });

    this.version(11).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]",
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+createdAt], [accountPubkey+senderPubkey]",
      conversationStates: "[accountPubkey+conversationId], accountPubkey, [accountPubkey+lastMessageAt]",
      conversationReadStates: "[accountPubkey+conversationId], accountPubkey",
      messageSyncStates: "accountPubkey",
      decryptedEvents: "[accountPubkey+eventId], accountPubkey, [accountPubkey+decryptedAt]",
      accountFriendships: "[accountPubkey+peerPubkey], accountPubkey, [accountPubkey+state], [accountPubkey+updatedAt]",
      accountProfiles: "[accountPubkey+ownerPubkey], accountPubkey, [accountPubkey+updatedAt]",
      outgoingQueue: "[accountPubkey+outgoingId], accountPubkey, [accountPubkey+state], [accountPubkey+nextAttemptAt]",
      outgoingDmTasks: "[accountPubkey+localId], accountPubkey, [accountPubkey+peerPubkey], [accountPubkey+state], [accountPubkey+updatedAt]",
      accountBookmarks: "[accountPubkey+messageId], accountPubkey, [accountPubkey+createdAt]"
    });

    this.version(12).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]",
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+createdAt], [accountPubkey+senderPubkey]",
      conversationStates: "[accountPubkey+conversationId], accountPubkey, [accountPubkey+lastMessageAt]",
      conversationReadStates: "[accountPubkey+conversationId], accountPubkey",
      messageSyncStates: "accountPubkey",
      decryptedEvents: "[accountPubkey+eventId], accountPubkey, [accountPubkey+decryptedAt]",
      accountFriendships: "[accountPubkey+peerPubkey], accountPubkey, [accountPubkey+state], [accountPubkey+updatedAt]",
      accountProfiles: "[accountPubkey+ownerPubkey], accountPubkey, [accountPubkey+updatedAt]",
      outgoingQueue: "[accountPubkey+outgoingId], accountPubkey, [accountPubkey+state], [accountPubkey+nextAttemptAt]",
      outgoingDmTasks: "[accountPubkey+localId], accountPubkey, [accountPubkey+peerPubkey], [accountPubkey+state], [accountPubkey+updatedAt]",
      accountBookmarks: "[accountPubkey+messageId], accountPubkey, [accountPubkey+createdAt]",
      deviceKeyValues: "key, updatedAt",
      accountStateMirrors: "[accountPubkey+namespace], accountPubkey, [accountPubkey+updatedAt]"
    });

    // Durable quarantine for messages whose friendship authorization cannot be
    // decided yet. These rows survive reloads so a later accepted/rejected
    // friendship snapshot can re-evaluate them without relying on Relay replay.
    this.version(13).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp",
      accountMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+created_at], [accountPubkey+pubkey], [accountPubkey+pubkey+created_at]",
      accountFriends: "[accountPubkey+pubkey], accountPubkey, [accountPubkey+name], [accountPubkey+group]",
      accountMeta: "[accountPubkey+key], accountPubkey",
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp]",
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+createdAt], [accountPubkey+senderPubkey]",
      conversationStates: "[accountPubkey+conversationId], accountPubkey, [accountPubkey+lastMessageAt]",
      conversationReadStates: "[accountPubkey+conversationId], accountPubkey",
      messageSyncStates: "accountPubkey",
      decryptedEvents: "[accountPubkey+eventId], accountPubkey, [accountPubkey+decryptedAt]",
      deferredAuthorizationMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+createdAt], [accountPubkey+deferredAt]",
      accountFriendships: "[accountPubkey+peerPubkey], accountPubkey, [accountPubkey+state], [accountPubkey+updatedAt]",
      accountProfiles: "[accountPubkey+ownerPubkey], accountPubkey, [accountPubkey+updatedAt]",
      outgoingQueue: "[accountPubkey+outgoingId], accountPubkey, [accountPubkey+state], [accountPubkey+nextAttemptAt]",
      outgoingDmTasks: "[accountPubkey+localId], accountPubkey, [accountPubkey+peerPubkey], [accountPubkey+state], [accountPubkey+updatedAt]",
      accountBookmarks: "[accountPubkey+messageId], accountPubkey, [accountPubkey+createdAt]",
      deviceKeyValues: "key, updatedAt",
      accountStateMirrors: "[accountPubkey+namespace], accountPubkey, [accountPubkey+updatedAt]"
    });
    installLocalVault(this, requireVault);
    this.version(14).stores({
      syncedMessages: "[accountPubkey+id], accountPubkey, [accountPubkey+conversationId+createdAt], [accountPubkey+conversationId+createdAt+id], [accountPubkey+createdAt+id], [accountPubkey+conversationId+messageClass+createdAt+id], [accountPubkey+createdAt], [accountPubkey+senderPubkey]"
    }).upgrade(transaction => transaction.table("syncedMessages").toCollection().modify(record => {
      record.messageClass = record.tags?.some((tag: string[]) => tag[0] === "t" && tag[1] === "hainei-dm") ? "direct" : "other";
    }));

    // Encrypted Media Cache v1. Keep the legacy-compatible primary-key shape
    // because Dexie 3 cannot change primary keys in place. The "url" column now
    // stores only a SHA-256 cache id, never the key-bearing media reference.
    // Clear legacy plaintext rows and add lastAccess for disk LRU.
    this.version(15).stores({
      accountImageCache: "[accountPubkey+url], accountPubkey, [accountPubkey+timestamp], [accountPubkey+lastAccess]"
    }).upgrade(transaction => transaction.table("accountImageCache").clear());

    this.version(16).stores({
      replaceableEventOutbox: "[accountPubkey+key], accountPubkey, [accountPubkey+nextAttemptAt]"
    });

    this.version(17).stores({
      dmRelayDirectory: "[accountPubkey+ownerPubkey], accountPubkey, [accountPubkey+expiresAt]"
    });

    // PR1: additive account-scoped private notes. No existing data is rewritten.
    this.version(18).stores({
      accountNotes: "[accountPubkey+id], accountPubkey, [accountPubkey+updatedAt]"
    });
    // Metadata is inside the vault envelope; old v18 rows remain readable.
    this.version(19).stores({
      accountNotes: "[accountPubkey+id], accountPubkey, [accountPubkey+updatedAt]"
    });

  }
}

export const db = new HaiNeiDatabase();
