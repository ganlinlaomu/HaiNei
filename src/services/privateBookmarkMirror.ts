import type { EventTemplate, NostrEvent, VerifiedEvent } from "nostr-tools";
import type { BookmarkRecord } from "@/db/dexie";
import { bookmarkRepository } from "@/repositories/bookmarkRepository";
import { replaceableEventOutboxRepository } from "@/repositories/replaceableEventOutboxRepository";
import { getRelaysFromStorage, publish, subscribe } from "@/nostr/relays";
import { verifySignedEvent } from "@/nostr/messaging/protocol/common";
import { noteBookmarkLocalMutation } from "@/services/bookmarkCloudSync";
import { logger } from "@/utils/logger";

export const NIP51_BOOKMARK_KIND = 10003;
const QUERY_TIMEOUT_MS = 8_000;
const MIRROR_DEBOUNCE_MS = 700;
const OUTBOX_RETRY_MS = 5_000;
const MIRROR_RECOVERY_RETRY_MS = 60_000;
const BOOKMARK_OUTBOX_KEY = String(NIP51_BOOKMARK_KIND);
const HEX_64 = /^[0-9a-f]{64}$/i;

export type PrivateBookmarkMirrorKeys = {
  pkHex: string;
  sessionGeneration?: number;
  supportsNip44: boolean;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
};

export type PrivateBookmarkSnapshot = {
  event: NostrEvent;
  publicTags: string[][];
  privateTags: string[][];
};

const scheduled = new Map<string, ReturnType<typeof setTimeout>>();

function normalizeTagList(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!Array.isArray(item) || item.length < 2 || !item.every(part => typeof part === "string")) return [];
    return [item.slice()];
  });
}

function eventId(tag: string[]) {
  if (tag[0] !== "e" || !HEX_64.test(tag[1] || "")) return "";
  return tag[1].toLowerCase();
}

function activeEventIds(tags: string[][]) {
  return new Set(tags.map(eventId).filter(Boolean));
}

function isNewerReplaceable(candidate: NostrEvent, current: NostrEvent | null) {
  if (!current) return true;
  if (candidate.created_at !== current.created_at) return candidate.created_at > current.created_at;
  return candidate.id.localeCompare(current.id) < 0;
}

async function decodeSnapshot(keys: PrivateBookmarkMirrorKeys, event: NostrEvent): Promise<PrivateBookmarkSnapshot> {
  const account = keys.pkHex.toLowerCase();
  if (
    event.kind !== NIP51_BOOKMARK_KIND ||
    event.pubkey.toLowerCase() !== account ||
    !verifySignedEvent(event)
  ) {
    throw new Error("invalid_nip51_bookmark_event");
  }

  const publicTags = normalizeTagList(event.tags);
  let privateTags: string[][] = [];
  if (event.content) {
    let plaintext: string;
    try {
      plaintext = await keys.nip44Decrypt(account, event.content);
    } catch {
      // NIP-51 historically allowed NIP-04. HaiNei intentionally does not
      // rewrite a private list it cannot decrypt, because that could destroy
      // bookmarks created by another client.
      throw new Error("unsupported_or_unreadable_nip51_bookmark_content");
    }
    privateTags = normalizeTagList(JSON.parse(plaintext));
  }

  return { event, publicTags, privateTags };
}

async function fetchLatestSnapshot(keys: PrivateBookmarkMirrorKeys): Promise<{
  snapshot: PrivateBookmarkSnapshot | null;
  available: boolean;
}> {
  const account = keys.pkHex.toLowerCase();
  const relays = getRelaysFromStorage("read");
  if (!account || !relays.length) return { snapshot: null, available: false };

  return new Promise((resolve, reject) => {
    const subscription = subscribe(relays, [{
      kinds: [NIP51_BOOKMARK_KIND],
      authors: [account],
      limit: 1,
    }]);
    const settled = new Set<string>();
    const eose = new Set<string>();
    let best: NostrEvent | null = null;
    let finished = false;

    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscription.unsub();
      if (!best) {
        // Do not create a brand-new global list unless every configured read relay
        // completed the query. A partial empty result could otherwise overwrite a
        // list that only exists on a temporarily unavailable relay.
        resolve({ snapshot: null, available: eose.size === relays.length });
        return;
      }
      try {
        resolve({ snapshot: await decodeSnapshot(keys, best), available: true });
      } catch (error) {
        reject(error);
      }
    };

    subscription.on("event", (event: NostrEvent) => {
      if (
        event.kind !== NIP51_BOOKMARK_KIND ||
        event.pubkey?.toLowerCase() !== account ||
        !verifySignedEvent(event)
      ) return;
      if (isNewerReplaceable(event, best)) best = event;
    });
    subscription.on("eose", (relayUrl: string) => {
      settled.add(relayUrl);
      eose.add(relayUrl);
      if (settled.size >= relays.length) void finish();
    });
    subscription.on("failure", (relayUrl: string) => {
      settled.add(relayUrl);
      if (settled.size >= relays.length) void finish();
    });

    const timer = setTimeout(() => void finish(), QUERY_TIMEOUT_MS);
  });
}

/**
 * Treat one NIP-51 replaceable event as a snapshot-level membership write.
 * Per-item HaiNei timestamps still win when they are newer than that snapshot.
 */
export function mergeNip51BookmarkRecords(
  local: BookmarkRecord[],
  remoteActiveIds: Iterable<string>,
  remoteUpdatedAt: number,
): BookmarkRecord[] {
  const remote = new Set([...remoteActiveIds].map(id => id.toLowerCase()).filter(id => HEX_64.test(id)));
  const merged = new Map(local.map(record => [record.messageId.toLowerCase(), { ...record, messageId: record.messageId.toLowerCase() }]));

  const ids = new Set([...merged.keys(), ...remote]);
  for (const id of ids) {
    const current = merged.get(id);
    const currentUpdatedAt = Number(current?.updatedAt ?? current?.createdAt ?? 0);
    if (current && currentUpdatedAt > remoteUpdatedAt) continue;

    if (!current) {
      if (remote.has(id)) {
        merged.set(id, {
          accountPubkey: local[0]?.accountPubkey || "",
          messageId: id,
          createdAt: remoteUpdatedAt,
          updatedAt: remoteUpdatedAt,
          deleted: false,
        });
      }
      continue;
    }

    // NIP-51 is an interoperability mirror, not HaiNei's deletion
    // authority. A replaceable snapshot can be partial, stale on some relays,
    // or produced by another client with different visibility semantics.
    // Remote presence may restore/import a bookmark, but remote absence must
    // never tombstone an existing HaiNei bookmark.
    if (remote.has(id)) {
      merged.set(id, {
        ...current,
        deleted: false,
        updatedAt: remoteUpdatedAt,
      });
    }
  }

  return [...merged.values()];
}

export function recoverNip51SnapshotDeletionBatch(records: BookmarkRecord[], now = Date.now()): BookmarkRecord[] {
  const active = records.filter(record => !record.deleted);
  if (active.length || !records.length) return [];

  // Historic NIP-51 imports stamped every removal with the replaceable
  // event's second-resolution created_at. Local HaiNei removals use Date.now().
  // If the visible collection is completely empty, recover only the newest
  // second-aligned deletion batch; older user tombstones remain untouched.
  const deleted = records.filter(record => record.deleted);
  const latest = Math.max(...deleted.map(record => Number(record.updatedAt || 0)));
  if (!latest || latest % 1000 !== 0) return [];
  const candidates = deleted.filter(record =>
    Number(record.updatedAt || 0) === latest
    && Number(record.createdAt || 0) < latest
  );
  if (!candidates.length) return [];

  return candidates.map((record, index) => ({
    ...record,
    deleted: false,
    updatedAt: now + index,
  }));
}

export function buildNip51BookmarkPayload(
  records: BookmarkRecord[],
  snapshot: Pick<PrivateBookmarkSnapshot, "publicTags" | "privateTags"> | null = null,
) {
  const active = records
    .filter(record => !record.deleted && HEX_64.test(record.messageId))
    .map(record => ({ ...record, messageId: record.messageId.toLowerCase() }))
    .sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
  const activeIds = new Set(active.map(record => record.messageId));
  const represented = new Set<string>();
  const publicTags: string[][] = [];
  const privateTags: string[][] = [];

  for (const tag of snapshot?.publicTags || []) {
    const id = eventId(tag);
    if (!id) {
      if (tag[0] !== "e") publicTags.push(tag.slice());
      continue;
    }
    if (!activeIds.has(id) || represented.has(id)) continue;
    publicTags.push([tag[0], id, ...tag.slice(2)]);
    represented.add(id);
  }

  for (const tag of snapshot?.privateTags || []) {
    const id = eventId(tag);
    if (!id) {
      if (tag[0] !== "e") privateTags.push(tag.slice());
      continue;
    }
    if (!activeIds.has(id) || represented.has(id)) continue;
    privateTags.push([tag[0], id, ...tag.slice(2)]);
    represented.add(id);
  }

  // HaiNei-created bookmarks are private by default. Existing public/private
  // placement from other NIP-51 clients is preserved above.
  for (const record of active) {
    if (represented.has(record.messageId)) continue;
    privateTags.push(["e", record.messageId]);
    represented.add(record.messageId);
  }

  return { publicTags, privateTags };
}

function recordChanged(before: BookmarkRecord | undefined, after: BookmarkRecord) {
  return !before ||
    before.createdAt !== after.createdAt ||
    Number(before.updatedAt || 0) !== Number(after.updatedAt || 0) ||
    !!before.deleted !== !!after.deleted;
}

function isCurrent(keys: PrivateBookmarkMirrorKeys, account: string, generation: number | undefined) {
  return keys.pkHex.toLowerCase() === account &&
    keys.supportsNip44 &&
    (generation === undefined || keys.sessionGeneration === generation);
}

async function flushBookmarkOutbox(account: string) {
  const queued = await replaceableEventOutboxRepository.get(account, BOOKMARK_OUTBOX_KEY);
  if (!queued) return true;
  if ((queued.nextAttemptAt || 0) > Date.now()) return false;

  const relays = getRelaysFromStorage("write");
  const targets = relays.length ? relays : queued.relays;
  if (!targets.length) return false;
  const attempts = queued.attempts + 1;
  try {
    const results = await publish(targets, queued.event);
    if (!results.some(result => result.ok)) throw new Error("nip51_bookmark_publish_failed");
    // Delete only if this exact event is still current. A newer local snapshot
    // may have replaced it while the network request was in flight.
    const current = await replaceableEventOutboxRepository.get(account, BOOKMARK_OUTBOX_KEY);
    if (current?.event.id === queued.event.id) {
      await replaceableEventOutboxRepository.delete(account, BOOKMARK_OUTBOX_KEY);
    }
    return true;
  } catch (error) {
    const current = await replaceableEventOutboxRepository.get(account, BOOKMARK_OUTBOX_KEY);
    if (current?.event.id === queued.event.id) {
      const delay = Math.min(5 * 60_000, 2 ** Math.min(attempts, 8) * 1_000);
      await replaceableEventOutboxRepository.update(account, BOOKMARK_OUTBOX_KEY, {
        attempts,
        nextAttemptAt: Date.now() + delay,
        lastError: error instanceof Error ? error.message : "publish_failed",
        updatedAt: Date.now(),
      });
    }
    return false;
  }
}

export async function syncPrivateBookmarkMirror(keys: PrivateBookmarkMirrorKeys) {
  const account = keys.pkHex.toLowerCase();
  const generation = keys.sessionGeneration;
  if (!account || !keys.supportsNip44) return false;

  const pending = await replaceableEventOutboxRepository.get(account, BOOKMARK_OUTBOX_KEY);
  if (pending) {
    const newestLocalChange = (await bookmarkRepository.list(account)).reduce(
      (latest, record) => Math.max(latest, Number(record.updatedAt ?? record.createdAt ?? 0)),
      0,
    );
    if (newestLocalChange > pending.createdAt) {
      // The queued signed snapshot is stale. Drop it before it reaches a relay;
      // this replaceable key is latest-wins and will be rebuilt below.
      await replaceableEventOutboxRepository.delete(account, BOOKMARK_OUTBOX_KEY);
    }
  }

  // A signed replacement survives reload/offline periods. Publish it before
  // reading the old remote snapshot so stale relay state cannot undo a newer
  // local bookmark change.
  if (!(await flushBookmarkOutbox(account))) return false;

  const { snapshot, available } = await fetchLatestSnapshot(keys);
  if (!isCurrent(keys, account, generation)) return false;
  if (!snapshot && !available) return false;

  const local = await bookmarkRepository.list(account);
  if (!isCurrent(keys, account, generation)) return false;

  let merged = local;
  if (snapshot) {
    const remoteIds = new Set([
      ...activeEventIds(snapshot.publicTags),
      ...activeEventIds(snapshot.privateTags),
    ]);
    merged = mergeNip51BookmarkRecords(local, remoteIds, snapshot.event.created_at * 1000)
      .map(record => ({ ...record, accountPubkey: account }));

    const before = new Map(local.map(record => [record.messageId.toLowerCase(), record]));
    const changed = merged.filter(record => recordChanged(before.get(record.messageId.toLowerCase()), record));
    if (changed.length) {
      await Promise.all(changed.map(record => bookmarkRepository.put(record)));
      if (!isCurrent(keys, account, generation)) return false;
      noteBookmarkLocalMutation(keys, account);
    }
  }

  const payload = buildNip51BookmarkPayload(merged, snapshot);
  const sameAsRemote = !!snapshot &&
    JSON.stringify(payload.publicTags) === JSON.stringify(snapshot.publicTags) &&
    JSON.stringify(payload.privateTags) === JSON.stringify(snapshot.privateTags);

  if (sameAsRemote) return true;
  if (!snapshot && payload.publicTags.length === 0 && payload.privateTags.length === 0) return true;

  const writeRelays = getRelaysFromStorage("write");
  if (!writeRelays.length) return false;

  const content = payload.privateTags.length
    ? await keys.nip44Encrypt(account, JSON.stringify(payload.privateTags))
    : "";
  if (!isCurrent(keys, account, generation)) return false;

  const now = Math.floor(Date.now() / 1000);
  const createdAt = snapshot ? Math.max(now, snapshot.event.created_at + 1) : now;
  const event = await keys.signEvent({
    kind: NIP51_BOOKMARK_KIND,
    created_at: createdAt,
    tags: payload.publicTags,
    content,
  });
  if (!isCurrent(keys, account, generation)) return false;

  const queuedAt = Date.now();
  await replaceableEventOutboxRepository.putLatest({
    accountPubkey: account,
    key: BOOKMARK_OUTBOX_KEY,
    event,
    relays: writeRelays,
    attempts: 0,
    createdAt: queuedAt,
    updatedAt: queuedAt,
  });
  if (!(await flushBookmarkOutbox(account))) throw new Error("nip51_bookmark_publish_failed");
  return true;
}

export function schedulePrivateBookmarkMirror(keys: PrivateBookmarkMirrorKeys, delay = MIRROR_DEBOUNCE_MS) {
  if (typeof window === "undefined" || !keys.pkHex || !keys.supportsNip44) return;
  const account = keys.pkHex.toLowerCase();
  const generation = keys.sessionGeneration;
  const id = `${account}:${generation ?? 0}`;
  const current = scheduled.get(id);
  if (current) clearTimeout(current);

  scheduled.set(id, setTimeout(() => {
    scheduled.delete(id);
    if (!isCurrent(keys, account, generation)) return;
    void syncPrivateBookmarkMirror(keys).then(async success => {
      if (!success && isCurrent(keys, account, generation)) {
        const pending = await replaceableEventOutboxRepository.get(account, BOOKMARK_OUTBOX_KEY);
        schedulePrivateBookmarkMirror(keys, pending ? OUTBOX_RETRY_MS : MIRROR_RECOVERY_RETRY_MS);
      }
    }).catch(async error => {
      logger.warn("[bookmarks] NIP-51 mirror sync failed", error);
      const pending = await replaceableEventOutboxRepository.get(account, BOOKMARK_OUTBOX_KEY);
      schedulePrivateBookmarkMirror(keys, pending ? OUTBOX_RETRY_MS : MIRROR_RECOVERY_RETRY_MS);
    });
  }, delay));
}
