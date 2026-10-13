import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRelays: vi.fn(() => ["wss://read.test"]),
  warm: vi.fn(),
  getDm: vi.fn(async () => ({ relays: ["wss://dm.test"] })),
}));

vi.mock("@/nostr/relays", () => ({
  getRelaysFromStorage: mocks.getRelays,
  warmRelays: mocks.warm,
}));
vi.mock("@/services/dmRelayDirectory", () => ({
  getOwnDmRelayStatus: mocks.getDm,
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

describe("cached NIP-17 inbox warmup", () => {
  it("opens the saved inbox relays without waiting for cloud read-state restoration", async () => {
    const active = { isLoggedIn: true, isUnlocked: true };
    await expect(warmDmRelaysForSession("a".repeat(64), active, () => true)).resolves.toBe(true);
    expect(mocks.getDm).toHaveBeenCalledWith("a".repeat(64));
    expect(mocks.warm).toHaveBeenCalledWith(["wss://dm.test"]);
  });

  it("does not touch the previous account's relays after an account switch", async () => {
    let release!: (value: { relays: string[] }) => void;
    const gate = new Promise<{ relays: string[] }>(resolve => { release = resolve; });
    mocks.getDm.mockReturnValueOnce(gate);
    const active = { isLoggedIn: true, isUnlocked: true };
    let current = true;
    const warming = warmDmRelaysForSession("a".repeat(64), active, () => current);
    current = false;
    release({ relays: ["wss://stale.test"] });
    await expect(warming).resolves.toBe(false);
    expect(mocks.warm).not.toHaveBeenCalled();
  });

  it("skips locked or logged-out sessions", async () => {
    await expect(warmDmRelaysForSession("a".repeat(64), { isLoggedIn: true, isUnlocked: false }, () => true)).resolves.toBe(false);
    await expect(warmDmRelaysForSession("a".repeat(64), { isLoggedIn: false, isUnlocked: true }, () => true)).resolves.toBe(false);
    expect(mocks.getDm).not.toHaveBeenCalled();
  });
});
