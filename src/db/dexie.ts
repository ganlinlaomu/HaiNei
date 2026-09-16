import Dexie, { type Table, type Transaction } from "dexie";

export const APP_VERSION = "0.1.5";
export const DB_VERSION = 4;
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
};

export type DBMeta = {
  key: string;
  value?: unknown;
  [key: string]: unknown;
};

export type DBImageCache = {
  url: string;
  blob: Blob;
  timestamp: number;
  mime: string;
};

export type AccountMessageRecord = DBMessage & { accountPubkey: string };
export type AccountFriendRecord = DBFriend & { accountPubkey: string };
export type AccountMetaRecord = DBMeta & { accountPubkey: string };
export type AccountImageCacheRecord = DBImageCache & { accountPubkey: string };

export type SyncedMessageRecord = {
  accountPubkey: string;
  id: string;
  senderPubkey: string;
  recipientPubkeys: string[];
  conversationId: string;
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
};

export type MessageSyncStateRecord = {
  accountPubkey: string;
  lastSuccessfulSyncAt?: number;
  /** Marks completion of the bounded, one-time history repair for this device. */
  historyBackfillCompletedAt?: number;
  historyBackfillRelaySignature?: string;
  highWatermarkCreatedAt?: number;
  lastRealtimeConnectedAt?: number;
  lastCatchupCompletedAt?: number;
  status: "idle" | "connecting" | "catching-up" | "live" | "offline" | "error";
  relayStates: Record<string, RelaySyncStateRecord>;
};

const ACCOUNT_SCOPED_KEY_PATTERNS = [
  /^nostr_(?:inbox|outbox|friends|notifications|settings)_([0-9a-f]{64})$/i,
  /^interactions_([0-9a-f]{64})$/i,
  /^home_lastSeenCreatedAt_([0-9a-f]{64})$/i,
  /^backfill_breakpoint_(?:messages|interactions)_([0-9a-f]{64})$/i,
  /^encrypted_sk_([0-9a-f]{64})$/i,
];

/** Resolve ownership only when browser storage proves there is one account. */
export function resolveUnambiguousLegacyAccount(storage: Storage | undefined = globalThis.localStorage): string | null {
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
    await transaction.table<AccountImageCacheRecord>("accountImageCache").bulkPut(
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

  constructor(name = DATABASE_NAME) {
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
  }
}

export const db = new HaiNeiDatabase();
