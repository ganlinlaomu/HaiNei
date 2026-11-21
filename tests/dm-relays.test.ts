import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRelays: vi.fn() }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: mocks.getRelays }));

import { DEFAULT_RELAY_URLS } from "@/services/connectionSettings";
import { dmReceiveRelays, dmSendRelays } from "@/services/dmRelays";

describe("fixed private-message relays", () => {
  beforeEach(() => {
    mocks.getRelays.mockReset().mockImplementation((mode: string) => mode === "write"
      ? ["wss://mine-write.test", DEFAULT_RELAY_URLS[0]]
      : ["wss://mine-read.test/"]);
  });

  it("sends to the defaults plus the user's write relays, deduplicated", () => {
    expect(dmSendRelays()).toEqual([...DEFAULT_RELAY_URLS, "wss://mine-write.test"]);
  });

  it("receives on the defaults plus the user's read relays", () => {
    expect(dmReceiveRelays()).toEqual([...DEFAULT_RELAY_URLS, "wss://mine-read.test"]);
  });

  it("keeps the defaults even when the user turned every one of them off", () => {
    mocks.getRelays.mockReturnValue([]);
    expect(dmSendRelays()).toEqual([...DEFAULT_RELAY_URLS]);
    expect(dmReceiveRelays()).toEqual([...DEFAULT_RELAY_URLS]);
  });

  it("two users who both added the same relay share it in both directions", () => {
    mocks.getRelays.mockReturnValue(["wss://shared.test"]);
    const aliceSends = dmSendRelays();
    const bobReceives = dmReceiveRelays();
    expect(aliceSends.filter(relay => bobReceives.includes(relay))).toContain("wss://shared.test");
  });
});
