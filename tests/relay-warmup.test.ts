import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRelays: vi.fn(() => ["wss://read.test"]),
  warm: vi.fn(),
}));

vi.mock("@/nostr/relays", () => ({
  getRelaysFromStorage: mocks.getRelays,
  warmRelays: mocks.warm,
}));

import { warmReadRelaysForSession } from "@/nostr/relayWarmup";

beforeEach(() => vi.clearAllMocks());

describe("account relay warmup", () => {
  it("runs only for a logged-in and unlocked account", () => {
    expect(warmReadRelaysForSession({ isLoggedIn: false, isUnlocked: false })).toBe(false);
    expect(warmReadRelaysForSession({ isLoggedIn: true, isUnlocked: false })).toBe(false);
    expect(mocks.warm).not.toHaveBeenCalled();

    expect(warmReadRelaysForSession({ isLoggedIn: true, isUnlocked: true })).toBe(true);
    expect(mocks.getRelays).toHaveBeenCalledWith("read");
    expect(mocks.warm).toHaveBeenCalledWith(["wss://read.test"]);
  });
});
