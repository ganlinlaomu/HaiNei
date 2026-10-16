import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import type { FriendshipRecord, OutgoingDmTaskRecord } from "@/db/dexie";
import type { InboxItem } from "@/stores/messages";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);

vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: "a".repeat(64), supportsNip44: true, signEvent: vi.fn(), nip44Encrypt: vi.fn() }) }));
vi.mock("@/repositories/metaRepository", () => ({
  metaRepository: { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), listPrefix: vi.fn(async () => []) },
}));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => [] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: vi.fn() }));

import DmBurnCountdown from "@/components/DmBurnCountdown.vue";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendshipsStore } from "@/stores/friendships";

function accepted(): FriendshipRecord {
  return {
    accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted", acceptedAt: 1, acceptedEventId: "a",
    acceptedWindows: [{ acceptedAt: 1, acceptedEventId: "a" }], updatedAt: 1,
  };
}

function incoming(index: number, createdAt: number): InboxItem {
  return {
    id: index.toString(16).padStart(64, "0"), pubkey: PEER, recipientPubkeys: [ACCOUNT], created_at: createdAt,
    content: `m${index}`, conversationId: `conversation:${PEER}`, protocol: "nip17", transportKind: 1059,
    tags: [["t", "hainei-dm"]],
  };
}

function setup() {
  const friendships = useFriendshipsStore();
  friendships.loadedFor = ACCOUNT;
  friendships.records = [accepted()];
  const direct = useDirectMessagesStore();
  direct.loadedFor = ACCOUNT;
  return direct;
}

beforeEach(() => setActivePinia(createPinia()));

describe("chat history merge", () => {
  it("keeps canonical order without a re-sort when no optimistic task is pending", () => {
    const direct = setup();
    const history = [incoming(3, 30), incoming(1, 10), incoming(2, 20)];
    expect(direct.mergePeerHistory(PEER, history).map(item => item.content)).toEqual(["m1", "m2", "m3"]);
  });

  it("still places an unmatched optimistic task at its timestamp", () => {
    const direct = setup();
    direct.outgoingTasks = [{
      accountPubkey: ACCOUNT, peerPubkey: PEER, localId: "pending", createdAt: 15, updatedAt: 15,
      text: "sending", state: "sending",
    } as OutgoingDmTaskRecord];
    const merged = direct.mergePeerHistory(PEER, [incoming(2, 20), incoming(1, 10)]);
    expect(merged.map(item => item.content)).toEqual(["m1", "sending", "m2"]);
  });
});

describe("burn countdown", () => {
  it("renders the remaining whole seconds on its own", async () => {
    const html = await renderToString(createSSRApp({ render: () => h(DmBurnCountdown, { deadline: Date.now() + 4_200 }) }));
    expect(html).toContain("♨ 5 秒后销毁");
    expect(html).toContain('role="timer"');
  });

  it("never shows a negative count after the deadline", async () => {
    const html = await renderToString(createSSRApp({ render: () => h(DmBurnCountdown, { deadline: Date.now() - 2_000 }) }));
    expect(html).toContain("♨ 0 秒后销毁");
  });

  it("the chat only advances its render clock when a countdown deadline is crossed", () => {
    const chat = readFileSync("src/views/Messages.vue", "utf8");
    expect(chat).toContain('<DmBurnCountdown class="temporary-countdown" :deadline="openedDeadlines[message.id]" />');
    expect(chat).toContain("deadline > clockNow.value && deadline <= now");
    expect(chat).not.toContain('{{ remainingBurnSeconds(message) }}');
  });

  it("compares message id lists without building a joined signature string", () => {
    const chat = readFileSync("src/views/Messages.vue", "utf8");
    expect(chat).toContain("if (sameIds(nextIds, previousIdsOrUndefined)) return;");
    expect(chat).not.toContain('.join("\\0")');
  });
});
