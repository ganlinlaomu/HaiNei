import { describe, expect, it, vi } from "vitest";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { createHomeMessageHandler } from "@/nostr/messaging/homeDelivery";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);

function message(id = "message"): CanonicalMessage {
  return {
    id,
    senderPubkey: PEER,
    recipientPubkeys: [ACCOUNT],
    conversationId: `conversation:${PEER}`,
    plaintext: "hello",
    createdAt: 100,
    protocol: "nip17",
    transportKind: 1059,
    tags: [],
  };
}

describe("message authorization deferral", () => {
  it("defers instead of rejecting while the friendship snapshot is not ready", async () => {
    const mirrorMessage = vi.fn();
    const handler = createHomeMessageHandler({
      accountPubkey: ACCOUNT,
      currentAccount: () => ACCOUNT,
      isAuthorizationReady: () => false,
      isAcceptedMessage: () => "rejected",
      isInteraction: () => false,
      processInteraction: vi.fn(),
      mirrorMessage,
    });

    expect(await handler(message(), { source: "realtime" })).toBe("defer");
    expect(mirrorMessage).not.toHaveBeenCalled();
  });

  it("distinguishes unresolved, rejected, and accepted authorization", async () => {
    const mirrorMessage = vi.fn();
    let decision: "accepted" | "rejected" | "unresolved" = "unresolved";
    const handler = createHomeMessageHandler({
      accountPubkey: ACCOUNT,
      currentAccount: () => ACCOUNT,
      isAuthorizationReady: () => true,
      isAcceptedMessage: () => decision,
      isInteraction: () => false,
      processInteraction: vi.fn(),
      mirrorMessage,
    });

    expect(await handler(message("unresolved"), { source: "realtime" })).toBe("defer");
    decision = "rejected";
    expect(await handler(message("rejected"), { source: "realtime" })).toBe(false);
    decision = "accepted";
    expect(await handler(message("accepted"), { source: "realtime" })).toBe(true);
    expect(mirrorMessage).toHaveBeenCalledTimes(1);
  });

  it("defers a stale account instead of advancing that account's cursor", async () => {
    const handler = createHomeMessageHandler({
      accountPubkey: ACCOUNT,
      currentAccount: () => "c".repeat(64),
      isInteraction: () => false,
      processInteraction: vi.fn(),
      mirrorMessage: vi.fn(),
    });
    expect(await handler(message(), { source: "realtime" })).toBe("defer");
  });
});
