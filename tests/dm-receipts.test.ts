import { describe, expect, it, vi } from "vitest";
import {
  DM_RECEIPT_TYPE,
  cursorAfter,
  cursorCovers,
  decodeDmReceipt,
  dmReceiptTags,
  isDmReceiptMessage,
  serializeDmReceipt,
} from "@/nostr/messaging/dmReceipts";
import { createHomeMessageHandler } from "@/nostr/messaging/homeDelivery";
import { MessageIngestionPipeline } from "@/nostr/messaging/sync/ingestion";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { receiptStatusForMessage } from "@/stores/directMessages";

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

describe("encrypted DM receipts", () => {
  it("encodes and validates private delivered/read cursor controls", () => {
    const delivered = receiptMessage("delivered");
    expect(isDmReceiptMessage(delivered)).toBe(true);
    expect(decodeDmReceipt(delivered)).toEqual({
      type: DM_RECEIPT_TYPE,
      status: "delivered",
      upTo: { createdAt: 100, messageId: FIRST },
    });

    expect(decodeDmReceipt({ ...delivered, tags: [["t", "hainei-dm"]] })).toBeNull();
    expect(decodeDmReceipt({
      ...delivered,
      plaintext: JSON.stringify({
        type: DM_RECEIPT_TYPE,
        status: "read",
        upTo: { createdAt: 100, messageId: "not-an-event-id" },
      }),
    })).toBeNull();
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
