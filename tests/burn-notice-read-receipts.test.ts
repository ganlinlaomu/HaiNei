// Disappearing DMs × read receipts: the recipient only sends the open
// confirmation (exact read receipt) when its read receipts are on. The
// sender then keeps its copy until the 48h expiry and says so in the UI.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { InboxItem } from "@/stores/messages";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const NOW_MS = 1_900_000_000_000;
const NOW = NOW_MS / 1000;

vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: "a".repeat(64), supportsNip44: true, signEvent: vi.fn(), nip44Encrypt: vi.fn() }) }));
vi.mock("@/services/accountStateSync", () => ({ scheduleAccountStateSync: vi.fn() }));
vi.mock("@/repositories/metaRepository", () => ({
  metaRepository: { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), listPrefix: vi.fn(async () => []) },
}));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => [] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: vi.fn() }));
vi.mock("@/repositories/outgoingDmTaskRepository", () => ({
  outgoingDmTaskRepository: { list: vi.fn(async () => []), get: vi.fn(), put: vi.fn(), update: vi.fn() },
}));

import { useDirectMessagesStore } from "@/stores/directMessages";
import { DISAPPEARING_DM_TYPE } from "@/nostr/messaging/disappearingMessages";
import { useSettingsStore } from "@/stores/settings";

function dm(id: string, sender: string, createdAt: number, extraTags: string[][] = []): InboxItem {
  return {
    id: id.padStart(64, "0"), pubkey: sender, recipientPubkeys: [sender === ACCOUNT ? PEER : ACCOUNT],
    created_at: createdAt, content: id, conversationId: "conversation", protocol: "nip17", transportKind: 1059,
    tags: [["t", "hainei-dm"], ...extraTags],
  };
}

function setup(readReceipts = true) {
  setActivePinia(createPinia());
  const settings = useSettingsStore();
  settings.loadedFor = ACCOUNT;
  settings.settings.privacy.readReceipts = readReceipts;
  const direct = useDirectMessagesStore();
  direct.loadedFor = ACCOUNT;
  return direct;
}

const burn = [["t", DISAPPEARING_DM_TYPE], ["burn-after", "10"], ["expiration", String(NOW + 48 * 3600)]];

beforeEach(() => vi.restoreAllMocks());

describe("why an open confirmation may never arrive", () => {
  it("infers the peer turned read receipts off when they replied but never acknowledged", () => {
    const direct = setup();
    const items = [dm("1", ACCOUNT, NOW - 600), dm("2", PEER, NOW - 300), dm("3", ACCOUNT, NOW - 200, burn)];
    expect(direct.readReceiptsHiddenReason(PEER, items, NOW_MS)).toBe("peer");
  });

  it("stays silent when the peer's read receipt covers our message", () => {
    const direct = setup();
    const items = [dm("1", ACCOUNT, NOW - 600), dm("2", PEER, NOW - 300), dm("3", ACCOUNT, NOW - 200, burn)];
    direct.receiptStateByPeer = { [PEER]: { read: { createdAt: NOW - 600, messageId: items[0].id } } };
    expect(direct.readReceiptsHiddenReason(PEER, items, NOW_MS)).toBeNull();
  });

  it("waits for the receipt grace period after a fresh reply", () => {
    const direct = setup();
    const items = [dm("1", ACCOUNT, NOW - 600), dm("2", PEER, NOW - 30), dm("3", ACCOUNT, NOW - 10, burn)];
    expect(direct.readReceiptsHiddenReason(PEER, items, NOW_MS)).toBeNull();
  });

  it("does not guess without a reply or from disappearing/pending messages", () => {
    const direct = setup();
    expect(direct.readReceiptsHiddenReason(PEER, [dm("1", ACCOUNT, NOW - 600)], NOW_MS)).toBeNull();
    const pending = { ...dm("1", ACCOUNT, NOW - 600), outgoing: { localId: "x", state: "sending" as const } };
    expect(direct.readReceiptsHiddenReason(PEER, [pending, dm("2", PEER, NOW - 300)], NOW_MS)).toBeNull();
    expect(direct.readReceiptsHiddenReason(PEER, [dm("1", ACCOUNT, NOW - 600, burn), dm("2", PEER, NOW - 300)], NOW_MS)).toBeNull();
  });

  it("knows for certain when our own read receipts are off", () => {
    const direct = setup(false);
    expect(direct.readReceiptsHiddenReason(PEER, [], NOW_MS)).toBe("self");
  });
});

describe("sender bubble", () => {
  const view = readFileSync("src/views/Messages.vue", "utf8");
  const burn = readFileSync("src/composables/useBurnMessages.ts", "utf8");

  it("explains the 48-hour fallback under our unopened disappearing message", () => {
    const ownBranch = view.slice(view.indexOf('<div v-else-if="isOwn(message)" class="temporary-message">'), view.indexOf('<div v-else-if="canShowTemporaryText(message)"'));
    expect(ownBranch).toContain('v-if="burnFallbackNotice(message)"');
    expect(burn).toContain('"对方关闭了已读回执，消息将在 48 小时后销毁"');
    const notice = burn.slice(burn.indexOf("function burnFallbackNotice"), burn.indexOf("function burnDuration"));
    expect(notice).toContain('outgoingReceiptStatus(options.peer(), message) === "read"');
    expect(notice).toContain("isBurned(message)");
  });

  it("leaves the protocol unchanged: the recipient still skips the open receipt when receipts are off", () => {
    const store = readFileSync("src/stores/directMessages.ts", "utf8");
    const ack = store.slice(store.indexOf("async acknowledgeOpenedDisappearing"), store.indexOf("async acknowledgeOpenedDisappearing") + 800);
    expect(ack).toContain("!readReceiptsEnabledForAccount(account)");
  });
});
