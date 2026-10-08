import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  DM_RECEIPT_TYPE,
  cursorAfter,
  cursorCovers,
  decodeDmReceipt,
  dmReceiptTags,
  isDmReceiptMessage,
  isDmReceiptPayload,
  serializeDmReceipt,
  serializeExactDmReadReceipt,
} from "@/nostr/messaging/dmReceipts";
import { createHomeMessageHandler } from "@/nostr/messaging/homeDelivery";
import { MessageIngestionPipeline } from "@/nostr/messaging/sync/ingestion";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { receiptStatusForMessage, useDirectMessagesStore } from "@/stores/directMessages";
import { useSettingsStore } from "@/stores/settings";
import { useKeyStore } from "@/stores/keys";
import { useFriendshipsStore } from "@/stores/friendships";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { metaRepository } from "@/repositories/metaRepository";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const FIRST = "1".repeat(64);
const SECOND = "2".repeat(64);

function receiptMessage(status: "delivered" | "read", createdAt = 100, messageId = FIRST): CanonicalMessage {
  return {
    id: "f".repeat(64),
    senderPubkey: PEER,
    recipientPubkeys: [ACCOUNT],
    conversationId: "conversation",
    plaintext: serializeDmReceipt(status, { createdAt, messageId }),
    createdAt: createdAt + 1,
    protocol: "nip17",
    transportKind: 1059,
    tags: dmReceiptTags(status),
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("encrypted DM receipts", () => {
  it("encodes and validates private delivered/read cursor controls", () => {
    const delivered = receiptMessage("delivered");
    expect(isDmReceiptMessage(delivered)).toBe(true);
    expect(decodeDmReceipt(delivered)).toEqual({
      type: DM_RECEIPT_TYPE,
      status: "delivered",
      upTo: { createdAt: 100, messageId: FIRST },
    });

    const legacyPayload = serializeDmReceipt("read", { createdAt: 100, messageId: FIRST });
    expect(isDmReceiptPayload(legacyPayload)).toBe(true);
    expect(decodeDmReceipt({ ...delivered, plaintext: legacyPayload, tags: [["t", "hainei-dm"]] })).toBeNull();
    expect(decodeDmReceipt({
      ...delivered,
      plaintext: JSON.stringify({
        type: DM_RECEIPT_TYPE,
        status: "read",
        upTo: { createdAt: 100, messageId: "not-an-event-id" },
      }),
    })).toBeNull();
  });

  it("validates exact per-message read receipts without changing older cursor receipts", () => {
    const opened = serializeExactDmReadReceipt({ createdAt: 100, messageId: FIRST });
    expect(decodeDmReceipt({
      ...receiptMessage("read"), plaintext: opened,
    })).toEqual({
      type: DM_RECEIPT_TYPE, status: "read", exact: true,
      upTo: { createdAt: 100, messageId: FIRST },
    });
    for (const payload of [
      JSON.stringify({ type: DM_RECEIPT_TYPE, status: "delivered", exact: true, upTo: { createdAt: 100, messageId: FIRST } }),
      JSON.stringify({ type: DM_RECEIPT_TYPE, status: "read", exact: "true", upTo: { createdAt: 100, messageId: FIRST } }),
      JSON.stringify({ type: DM_RECEIPT_TYPE, status: "read", exact: true, upTo: { createdAt: 100, messageId: "invalid" } }),
    ]) {
      expect(decodeDmReceipt({ ...receiptMessage("read"), plaintext: payload })).toBeNull();
    }
    expect(isDmReceiptPayload(opened)).toBe(true);
    expect(decodeDmReceipt({ ...receiptMessage("read"), plaintext: opened, tags: [] })).toBeNull();
  });

  it("shows read only for the explicitly opened temporary message, never earlier unopened ones", async () => {
    setActivePinia(createPinia());
    const keys = useKeyStore();
    keys.pkHex = ACCOUNT;
    const friendship = useFriendshipsStore();
    friendship.loadedFor = ACCOUNT;
    friendship.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted" } as any];
    const direct = useDirectMessagesStore();
    direct.loadedFor = ACCOUNT;
    direct.receiptStateByPeer[PEER] = {
      delivered: { createdAt: 105, messageId: SECOND },
      read: { createdAt: 105, messageId: SECOND },
    };
    const temporary = (id: string) => ({
      id, pubkey: ACCOUNT, created_at: 100,
      tags: [["t", "hainei-dm"], ["t", "hainei-dm-disappearing"]],
    });
    // The normal cumulative receipt can cover both messages, but neither
    // should be considered opened without the exact signed control.
    expect(direct.outgoingReceiptStatus(PEER, temporary(FIRST))).toBe("delivered");
    expect(direct.outgoingReceiptStatus(PEER, temporary(SECOND))).toBe("delivered");
    vi.spyOn(syncedMessageRepository, "get").mockResolvedValue({
      id: FIRST, senderPubkey: ACCOUNT, createdAt: 100,
      recipientPubkeys: [PEER], conversationId: "conversation",
      tags: [["t", "hainei-dm"], ["t", "hainei-dm-disappearing"]],
    } as any);
    const put = vi.spyOn(metaRepository, "put").mockImplementation(async (account, key, value) => ({
      accountPubkey: account, key, value,
    }));
    const exact: CanonicalMessage = {
      ...receiptMessage("read"), plaintext: serializeExactDmReadReceipt({ createdAt: 100, messageId: FIRST }),
    };
    expect(await direct.processReceipt(exact)).toBe(true);
    expect(put).toHaveBeenCalledWith(ACCOUNT, `dm-exact-read:${FIRST}`, expect.objectContaining({ peerPubkey: PEER }));
    expect(direct.exactReadById[FIRST]).toBe(PEER);
    expect(direct.outgoingReceiptStatus(PEER, temporary(FIRST))).toBe("read");
    expect(direct.outgoingReceiptStatus(PEER, temporary(SECOND))).toBe("delivered");
    // Exact read must never advance or overwrite the ordinary cumulative cursor.
    expect(direct.receiptStateByPeer[PEER]?.read).toEqual({ createdAt: 105, messageId: SECOND });
    expect(await direct.processReceipt(exact)).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
    expect(direct.outgoingReceiptStatus(PEER, {
      id: SECOND, created_at: 100, pubkey: ACCOUNT, tags: [["t", "hainei-dm"]],
    })).toBe("read");
  });

  it("rejects fake exact reads for normal messages or mismatched timestamps", async () => {
    setActivePinia(createPinia());
    const keys = useKeyStore();
    keys.pkHex = ACCOUNT;
    const friends = useFriendshipsStore();
    friends.loadedFor = ACCOUNT;
    friends.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted" } as any];
    const direct = useDirectMessagesStore();
    direct.loadedFor = ACCOUNT;
    vi.spyOn(syncedMessageRepository, "get").mockResolvedValue({
      id: FIRST, senderPubkey: ACCOUNT, createdAt: 101,
      recipientPubkeys: [PEER], tags: [["t", "hainei-dm"]],
    } as any);
    const put = vi.spyOn(metaRepository, "put");
    const exact = { ...receiptMessage("read"), plaintext: serializeExactDmReadReceipt({ createdAt: 100, messageId: FIRST }) };
    expect(await direct.processReceipt(exact)).toBe(false);
    expect(direct.exactReadById[FIRST]).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });

  it("advances cursors monotonically and lets read imply delivery", () => {
    expect(cursorAfter({ createdAt: 101, messageId: FIRST }, { createdAt: 100, messageId: SECOND })).toBe(true);
    expect(cursorAfter({ createdAt: 100, messageId: SECOND }, { createdAt: 100, messageId: FIRST })).toBe(true);
    expect(cursorAfter({ createdAt: 100, messageId: FIRST }, { createdAt: 100, messageId: SECOND })).toBe(false);

    const state = {
      delivered: { createdAt: 101, messageId: FIRST },
      read: { createdAt: 100, messageId: SECOND },
    };
    expect(receiptStatusForMessage({ id: FIRST, created_at: 99 }, state)).toBe("read");
    expect(receiptStatusForMessage({ id: FIRST, created_at: 101 }, state)).toBe("delivered");
    expect(receiptStatusForMessage({ id: SECOND, created_at: 102 }, state)).toBe("sent");
    expect(cursorCovers(state.read, { id: FIRST, created_at: 99 })).toBe(true);
  });

  it("honors the privacy opt-out without disabling delivery receipts", () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const directMessages = useDirectMessagesStore();
    const settings = useSettingsStore();
    directMessages.loadedFor = ACCOUNT;
    settings.loadedFor = ACCOUNT;
    settings.settings.privacy = { readReceipts: false, updatedAt: 1, updatedBy: "test" };

    directMessages.receiptStateByPeer[PEER] = {
      delivered: { createdAt: 100, messageId: FIRST },
      read: { createdAt: 101, messageId: SECOND },
    };
    expect(directMessages.outgoingReceiptStatus(PEER, {
      id: FIRST, created_at: 100, pubkey: ACCOUNT,
    } as any)).toBe("delivered");

    const flush = vi.spyOn(directMessages, "flushReceipt").mockResolvedValue(undefined);
    directMessages.scheduleReceipt(PEER, "read", { createdAt: 102, messageId: SECOND });
    vi.advanceTimersByTime(600);
    expect(flush).not.toHaveBeenCalled();

    directMessages.scheduleReceipt(PEER, "delivered", { createdAt: 102, messageId: SECOND });
    vi.advanceTimersByTime(600);
    expect(flush).toHaveBeenCalledWith(ACCOUNT, PEER, "delivered", expect.any(String));
  });

  it("routes receipt controls without mirroring them into chat history", async () => {
    const processReceipt = vi.fn(() => true);
    const mirrorMessage = vi.fn();
    const handler = createHomeMessageHandler({
      accountPubkey: ACCOUNT,
      currentAccount: () => ACCOUNT,
      isAcceptedMessage: () => true,
      isReceipt: isDmReceiptMessage,
      processReceipt,
      isInteraction: () => false,
      processInteraction: vi.fn(),
      mirrorMessage,
    });

    const handled = await handler(receiptMessage("read"), { source: "realtime" });
    expect(handled).toBe(false);
    expect(processReceipt).toHaveBeenCalledTimes(1);
    expect(mirrorMessage).not.toHaveBeenCalled();
  });

  it("emits delivery side effects only after durable persistence", async () => {
    const order: string[] = [];
    const message: CanonicalMessage = {
      id: FIRST,
      senderPubkey: PEER,
      recipientPubkeys: [ACCOUNT],
      conversationId: "conversation",
      plaintext: "hello",
      createdAt: 100,
      protocol: "nip17",
      transportKind: 1059,
      tags: [["t", "hainei-dm"]],
    };
    const repository = {
      enqueueMessage: vi.fn(async () => {
        order.push("persist");
        return { inserted: true, record: {} };
      }),
      clearDeferredAuthorizationMessage: vi.fn(async () => undefined),
      isBurnedMessage: vi.fn(async () => false),
    };

    const pipeline = new MessageIngestionPipeline(
      ACCOUNT,
      { accountPubkey: ACCOUNT },
      () => true,
      async () => { order.push("ui"); return true; },
      repository as any,
      async () => null,
      async (_message, _metadata, inserted) => {
        expect(inserted).toBe(true);
        order.push("receipt");
      },
    );

    await pipeline.ingestCanonicalMessage(message, { source: "realtime" });
    expect(order).toEqual(["ui", "persist", "receipt"]);
  });
});
