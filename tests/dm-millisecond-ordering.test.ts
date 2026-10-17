import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, utils, type EventTemplate } from "nostr-tools";
import { HaiNeiDatabase } from "@/db/dexie";
import { decryptDirectMessage, encryptDirectMessage, nip17Adapter, type CanonicalMessage } from "@/nostr/messaging/protocol";
import {
  compareMessages,
  isCursorAfter,
  isMessageAfter,
  messageMillis,
  nextMessageClock,
  readCursorFor,
  resetMessageClockForTests,
} from "@/nostr/messaging/sync/sorting";
import { cursorAfter, cursorCovers, decodeDmReceiptPayload, serializeDmReceipt } from "@/nostr/messaging/dmReceipts";
import { mergeNamespaceData } from "@/services/accountStateSync";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";

const aliceKey = utils.hexToBytes("3".padStart(64, "0"));
const bobKey = utils.hexToBytes("4".padStart(64, "0"));
const alice = getPublicKey(aliceKey);
const bob = getPublicKey(bobKey);
const aliceContext = {
  senderPubkey: alice,
  nip44Encrypt: (peer: string, plaintext: string) => encryptDirectMessage({ senderPrivateKey: aliceKey, recipientPubkey: peer, plaintext }),
  signEvent: (event: EventTemplate) => Promise.resolve(finalizeEvent(event, aliceKey)),
};
const bobDecode = {
  accountPubkey: bob,
  nip44Decrypt: (peer: string, ciphertext: string) => decryptDirectMessage({ recipientPrivateKey: bobKey, senderPubkey: peer, ciphertext }),
};
const aliceDecode = {
  accountPubkey: alice,
  nip44Decrypt: (peer: string, ciphertext: string) => decryptDirectMessage({ recipientPrivateKey: aliceKey, senderPubkey: peer, ciphertext }),
};

let dbIndex = 0;
const opened: HaiNeiDatabase[] = [];
function repository() {
  const database = new HaiNeiDatabase(`ms-ordering-test-${dbIndex++}`);
  opened.push(database);
  return new SyncedMessageRepository(database);
}

beforeEach(() => resetMessageClockForTests());
afterEach(async () => {
  vi.useRealTimers();
  for (const database of opened.splice(0)) {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  }
});

function msg(id: string, createdAt: number, ms?: number) {
  return { id: id.padStart(64, "0"), createdAt, tags: ms === undefined ? [] : [["ms", String(ms)]] };
}

describe("monotonic message clock", () => {
  it("adds one millisecond when several sends share the same millisecond", () => {
    const now = 1_900_000_000_500;
    expect(nextMessageClock(now)).toEqual({ createdAt: 1_900_000_000, ms: 500 });
    expect(nextMessageClock(now)).toEqual({ createdAt: 1_900_000_000, ms: 501 });
    expect(nextMessageClock(now)).toEqual({ createdAt: 1_900_000_000, ms: 502 });
    // A wall clock that steps backwards cannot reorder later sends.
    expect(nextMessageClock(now - 5_000)).toEqual({ createdAt: 1_900_000_000, ms: 503 });
    expect(nextMessageClock(now + 1_000)).toEqual({ createdAt: 1_900_000_001, ms: 500 });
  });

  it("reads 0..999 ms tags and treats missing or invalid tags as 0", () => {
    expect(messageMillis([["ms", "7"]])).toBe(7);
    expect(messageMillis([["ms", "999"]])).toBe(999);
    expect(messageMillis([])).toBe(0);
    for (const bad of ["1000", "-1", "1.5", "abc", ""]) expect(messageMillis([["ms", bad]])).toBe(0);
  });
});

describe("(created_at * 1000 + ms, id) order key", () => {
  it("orders within a second by ms first and by event id only on ties", () => {
    const late = msg("1", 100, 900);
    const early = msg("f", 100, 10);
    const legacy = msg("0", 100); // older client: no ms tag = .000
    expect([late, early, legacy].sort(compareMessages).map(item => item.id)).toEqual([legacy.id, early.id, late.id]);
    expect(compareMessages(msg("a", 100, 5), msg("b", 100, 5))).toBeLessThan(0);
  });

  it("uses the same key for read cursors so unread matches display order", () => {
    const messages = [msg("9", 100, 1), msg("1", 100, 2), msg("5", 100, 3)].sort(compareMessages);
    const cursor = readCursorFor(messages[1]);
    expect(messages.filter(item => isMessageAfter(item, cursor)).map(item => item.id)).toEqual([messages[2].id]);
    expect(isCursorAfter(readCursorFor(messages[2]), cursor)).toBe(true);
    expect(isCursorAfter(cursor, readCursorFor(messages[2]))).toBe(false);
  });

  it("keeps second-level semantics for cursors written before ms ordering", () => {
    const legacyCursor = { lastReadCreatedAt: 100, lastReadMessageId: "5".padStart(64, "0") };
    // Same second, smaller id, later ms: an old cursor already covered it.
    expect(isMessageAfter(msg("1", 100, 999), legacyCursor)).toBe(false);
    expect(isMessageAfter(msg("6", 100, 0), legacyCursor)).toBe(true);
    expect(isMessageAfter(msg("0", 101, 0), legacyCursor)).toBe(true);
  });

  it("merges cloud read_state from two devices by the same key", () => {
    const earlier = { conversationId: "c", lastReadCreatedAt: 100, lastReadMessageId: "f".repeat(64), lastReadMs: 10 };
    const later = { conversationId: "c", lastReadCreatedAt: 100, lastReadMessageId: "1".repeat(64), lastReadMs: 20 };
    expect(mergeNamespaceData("read_state", [later], [earlier])).toEqual([later]);
    expect(mergeNamespaceData("read_state", [earlier], [later])).toEqual([later]);
  });

  it("carries ms in delivered/read receipts and covers messages in display order", () => {
    const upTo = { createdAt: 100, messageId: "1".repeat(64), ms: 500 };
    const decoded = decodeDmReceiptPayload(serializeDmReceipt("read", upTo));
    expect(decoded?.upTo).toEqual(upTo);
    expect(cursorCovers(upTo, { id: "f".repeat(64), created_at: 100, tags: [["ms", "499"]] })).toBe(true);
    expect(cursorCovers(upTo, { id: "0".repeat(64), created_at: 100, tags: [["ms", "501"]] })).toBe(false);
    expect(cursorAfter({ ...upTo, ms: 501, messageId: "0".repeat(64) }, upTo)).toBe(true);
    // Receipts from older clients keep working at second granularity.
    expect(decodeDmReceiptPayload(serializeDmReceipt("read", { createdAt: 100, messageId: "1".repeat(64) }))?.upTo.ms).toBeUndefined();
  });
});

describe("three messages sent in the same second", () => {
  it("show in send order on both the sender's and the receiver's device", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(1_900_000_000_250));
    const sent: CanonicalMessage[] = [];
    const wrapsForBob = [];
    const wrapsForAlice = [];
    for (const text of ["一", "二", "三"]) {
      const encoded = await nip17Adapter.encode!({ recipientPubkeys: [bob], plaintext: text, tags: [["t", "hainei-dm"]] }, aliceContext);
      sent.push(encoded.message);
      wrapsForBob.push(encoded.events.find(event => event.tags[0][1] === bob)!);
      wrapsForAlice.push(encoded.events.find(event => event.tags[0][1] === alice)!);
    }
    expect(new Set(sent.map(message => message.createdAt)).size).toBe(1);
    expect(sent.map(message => messageMillis(message.tags))).toEqual([250, 251, 252]);

    // Relays deliver in any order; event ids are random relative to send order.
    const received = [];
    for (const wrap of [wrapsForBob[2], wrapsForBob[0], wrapsForBob[1]]) received.push((await nip17Adapter.decode(wrap, bobDecode))!);
    const echoed = [];
    for (const wrap of [wrapsForAlice[1], wrapsForAlice[2], wrapsForAlice[0]]) echoed.push((await nip17Adapter.decode(wrap, aliceDecode))!);

    const order = (items: CanonicalMessage[]) => [...items].sort(compareMessages).map(item => item.plaintext);
    expect(order(sent)).toEqual(["一", "二", "三"]);
    expect(order(received)).toEqual(["一", "二", "三"]);
    expect(order(echoed)).toEqual(["一", "二", "三"]);
  });

  it("keeps unread counts consistent with that order after reading the middle message", async () => {
    const repo = repository();
    const conversationId = "same-second";
    const base = { senderPubkey: bob, recipientPubkeys: [alice], conversationId, createdAt: 1_900_000_000, plaintext: "", protocol: "nip17" as const, transportKind: 1059 };
    // Ids deliberately sort opposite to send order.
    const messages = [
      { ...base, id: "c".repeat(64), transportEventId: "w1", tags: [["t", "hainei-dm"], ["ms", "1"]] },
      { ...base, id: "b".repeat(64), transportEventId: "w2", tags: [["t", "hainei-dm"], ["ms", "2"]] },
      { ...base, id: "a".repeat(64), transportEventId: "w3", tags: [["t", "hainei-dm"], ["ms", "3"]] },
    ];
    for (const message of messages) await repo.insertMessageIfAbsent(alice, message);
    expect(await repo.getUnreadCount(alice, conversationId)).toBe(3);

    await repo.advanceReadState(alice, conversationId, readCursorFor(messages[1]) as any);
    expect(await repo.getUnreadCount(alice, conversationId)).toBe(1);
    expect(await repo.getVisibleUnreadCount(alice, conversationId, "all", await repo.getReadState(alice, conversationId), () => true)).toBe(1);

    await repo.markRead(alice, conversationId);
    expect((await repo.getReadState(alice, conversationId))?.lastReadMessageId).toBe(messages[2].id);
    expect(await repo.getUnreadCount(alice, conversationId)).toBe(0);
  });
});
