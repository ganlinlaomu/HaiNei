import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRelays: vi.fn(() => ["wss://read.test"]),
  warm: vi.fn(),
  receive: vi.fn(() => ["wss://default.test", "wss://read.test"]),
}));

vi.mock("@/nostr/relays", () => ({
  getRelaysFromStorage: mocks.getRelays,
  warmRelays: mocks.warm,
}));
vi.mock("@/services/dmRelays", () => ({
  dmReceiveRelays: mocks.receive,
}));

import { warmDmRelaysForSession, warmReadRelaysForSession } from "@/nostr/relayWarmup";

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

describe("private message relay warmup", () => {
  it("opens the receive relays (defaults plus read relays) before account state is restored", async () => {
    const active = { isLoggedIn: true, isUnlocked: true };
    await expect(warmDmRelaysForSession("a".repeat(64), active, () => true)).resolves.toBe(true);
    expect(mocks.warm).toHaveBeenCalledWith(["wss://default.test", "wss://read.test"]);
  });

  it("does nothing for a session that is no longer current", async () => {
    const active = { isLoggedIn: true, isUnlocked: true };
    await expect(warmDmRelaysForSession("a".repeat(64), active, () => false)).resolves.toBe(false);
    expect(mocks.warm).not.toHaveBeenCalled();
  });

  it("skips locked or logged-out sessions", async () => {
    await expect(warmDmRelaysForSession("a".repeat(64), { isLoggedIn: true, isUnlocked: false }, () => true)).resolves.toBe(false);
    await expect(warmDmRelaysForSession("a".repeat(64), { isLoggedIn: false, isUnlocked: true }, () => true)).resolves.toBe(false);
    expect(mocks.receive).not.toHaveBeenCalled();
  });
});
