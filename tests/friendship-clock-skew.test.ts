// Friendship control timestamps come from the sender's clock and acceptance
// must order after the request, so a fast clock on either side pushes the
// accepted window into the future. Messages stamped by the other device's
// (correct) clock were then rejected and permanently discarded.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: "a".repeat(64) }) }));

import { FRIENDSHIP_CLOCK_SKEW_SECONDS, isFriendshipAcceptedAt, reduceFriendshipControl } from "@/stores/friendships";

const NOW = 1_900_000_000;
const SKEW = 10 * 60;
const ME = "a".repeat(64);
const PEER = "b".repeat(64);

/** Builds both sides' records for: PEER requests, ME accepts. */
function establish(peerClockOffset: number, myClockOffset: number) {
  const requestTs = NOW + peerClockOffset;
  const acceptTs = Math.max(NOW + myClockOffset, requestTs + 1); // sendControl rule
  const mine = reduceFriendshipControl(
    reduceFriendshipControl(undefined, { accountPubkey: ME, peerPubkey: PEER }, { action: "request", timestamp: requestTs, eventId: "req", selfMessage: false }),
    { accountPubkey: ME, peerPubkey: PEER },
    { action: "accept", timestamp: acceptTs, eventId: "acc", requestId: "req", selfMessage: true },
  )!;
  const theirs = reduceFriendshipControl(
    reduceFriendshipControl(undefined, { accountPubkey: PEER, peerPubkey: ME }, { action: "request", timestamp: requestTs, eventId: "req", selfMessage: true }),
    { accountPubkey: PEER, peerPubkey: ME },
    { action: "accept", timestamp: acceptTs, eventId: "acc", requestId: "req", selfMessage: false },
  )!;
  return { mine, theirs };
}

describe("friendship authorization under clock skew", () => {
  it("covers a realistic skew", () => {
    expect(FRIENDSHIP_CLOCK_SKEW_SECONDS).toBeGreaterThanOrEqual(SKEW);
  });

  it("peer clock fast: the peer still accepts my messages sent right after acceptance", () => {
    const { mine, theirs } = establish(SKEW, 0);
    expect(mine.state).toBe("accepted");
    expect(theirs.state).toBe("accepted");
    // My message one minute after accepting, stamped by my correct clock.
    expect(isFriendshipAcceptedAt(theirs, NOW + 60)).toBe(true);
    // Their message, stamped by their fast clock, on my side.
    expect(isFriendshipAcceptedAt(mine, NOW + 60 + SKEW)).toBe(true);
  });

  it("my clock fast: I still accept the peer's messages sent right after acceptance", () => {
    const { mine, theirs } = establish(0, SKEW);
    expect(isFriendshipAcceptedAt(mine, NOW + 60)).toBe(true);
    expect(isFriendshipAcceptedAt(theirs, NOW + 60 + SKEW)).toBe(true);
  });

  it("still rejects messages well before the friendship existed", () => {
    const { mine } = establish(0, 0);
    expect(isFriendshipAcceptedAt(mine, NOW - FRIENDSHIP_CLOCK_SKEW_SECONDS - 1)).toBe(false);
  });

  it("keeps the end of a removed window strict", () => {
    const { mine } = establish(0, 0);
    const removed = reduceFriendshipControl(mine, { accountPubkey: ME, peerPubkey: PEER }, { action: "remove", timestamp: NOW + 100, eventId: "rm", selfMessage: true })!;
    expect(removed.state).toBe("removed");
    expect(isFriendshipAcceptedAt(removed, NOW + 50)).toBe(true);
    expect(isFriendshipAcceptedAt(removed, NOW + 101)).toBe(false);
  });
});
