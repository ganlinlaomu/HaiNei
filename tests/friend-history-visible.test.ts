import { describe, expect, it } from "vitest";
import { isAuthorizedDirectMessage } from "@/stores/directMessages";

const ME = "a".repeat(64);
const FRIEND = "b".repeat(64);
const DAY = 24 * 60 * 60;
const today = 1_800_000_000;
const msg = (pubkey: string, createdAt: number) => ({ pubkey, created_at: createdAt });

describe("which of a friend's messages a chat shows", () => {
  // The reported case: the local record says the friendship began today at
  // 14:05, although the two have been friends for a long time.
  const accepted = {
    peerPubkey: FRIEND, state: "accepted", acceptedAt: today, acceptedWindows: [{ acceptedAt: today, acceptedEventId: "e" }],
  } as any;

  it("shows a current friend's whole history, also before the recorded acceptance", () => {
    expect(isAuthorizedDirectMessage(msg(FRIEND, today - 30 * DAY), ME, accepted)).toBe(true);
    expect(isAuthorizedDirectMessage(msg(FRIEND, today + 60), ME, accepted)).toBe(true);
  });

  it("still limits a removed friend to the time you were friends", () => {
    const removed = { ...accepted, state: "removed", acceptedWindows: [{ acceptedAt: today - 10 * DAY, acceptedEventId: "e", endedAt: today - DAY }] };
    expect(isAuthorizedDirectMessage(msg(FRIEND, today - 5 * DAY), ME, removed)).toBe(true);
    expect(isAuthorizedDirectMessage(msg(FRIEND, today - 20 * DAY), ME, removed)).toBe(false);
    expect(isAuthorizedDirectMessage(msg(FRIEND, today), ME, removed)).toBe(false);
  });

  it("never shows a stranger's messages, and always shows your own", () => {
    expect(isAuthorizedDirectMessage(msg(FRIEND, today), ME, undefined)).toBe(false);
    expect(isAuthorizedDirectMessage(msg(FRIEND, today), ME, { peerPubkey: FRIEND, state: "incoming_pending", acceptedWindows: [] } as any)).toBe(false);
    expect(isAuthorizedDirectMessage(msg(ME, today - 30 * DAY), ME, undefined)).toBe(true);
  });
});
