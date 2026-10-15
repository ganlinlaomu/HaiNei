// Review finding #1 (badge half, store side): markPeerRead synced the masked
// restoring count straight to the OS badge.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { FriendshipRecord } from "@/db/dexie";
import type { InboxItem } from "@/stores/messages";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const CONVERSATION = `conversation:${PEER}`;

vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: "a".repeat(64), supportsNip44: true, signEvent: vi.fn(), nip44Encrypt: vi.fn() }) }));
vi.mock("@/repositories/metaRepository", () => ({
  metaRepository: { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), listPrefix: vi.fn(async () => []) },
}));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => [] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: vi.fn() }));
vi.mock("@/repositories/outgoingDmTaskRepository", () => ({
  outgoingDmTaskRepository: { list: vi.fn(async () => []), get: vi.fn(), put: vi.fn(), update: vi.fn() },
}));
vi.mock("@/services/accountStateSync", () => ({ scheduleAccountStateSync: vi.fn() }));
vi.mock("@/utils/appBadge", async importOriginal => ({
  ...(await importOriginal<typeof import("@/utils/appBadge")>()),
  syncAppBadge: vi.fn(async () => {}),
}));

import { useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendshipsStore } from "@/stores/friendships";
import { useMessagesStore } from "@/stores/messages";
import { syncAppBadge } from "@/utils/appBadge";

function accepted(): FriendshipRecord {
  return {
    accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted", acceptedAt: 1, acceptedEventId: "a",
    acceptedWindows: [{ acceptedAt: 1, acceptedEventId: "a" }], updatedAt: 1,
  };
}

function incoming(id: string, createdAt: number): InboxItem {
  return {
    id, pubkey: PEER, recipientPubkeys: [ACCOUNT], created_at: createdAt, content: id,
    conversationId: CONVERSATION, protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]],
  };
}

async function setup(phase: "ready" | "restoring") {
  const messages = useMessagesStore();
  messages.loadedFor = ACCOUNT;
  messages.inbox = [incoming("1".repeat(64), 100)];
  const friendships = useFriendshipsStore();
  friendships.loadedFor = ACCOUNT;
  friendships.records = [accepted()];
  const direct = useDirectMessagesStore();
  await direct.refresh(ACCOUNT);
  direct.readStateRestorePhase = phase;
  vi.mocked(syncAppBadge).mockClear();
  return direct;
}

beforeEach(() => setActivePinia(createPinia()));

describe("review #1: badge writes from a foreground read", () => {
  it("does not push the masked count to the OS badge while unread is restoring", async () => {
    const direct = await setup("restoring");
    await direct.markPeerRead(PEER);
    expect(direct.readCursors[CONVERSATION]?.lastReadMessageId).toBe("1".repeat(64));
    expect(syncAppBadge).not.toHaveBeenCalled();
  });

  it("control: a ready store still updates the badge immediately on read", async () => {
    const direct = await setup("ready");
    await direct.markPeerRead(PEER);
    expect(syncAppBadge).toHaveBeenCalledWith(0, undefined, ACCOUNT);
  });
});
