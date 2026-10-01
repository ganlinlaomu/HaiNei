import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(() => ({ on: vi.fn(), unsub: vi.fn() })),
  publish: vi.fn(),
}));

vi.mock("@/nostr/relays", () => ({
  getRelaysFromStorage: () => [],
  subscribe: mocks.subscribe,
  publish: mocks.publish,
}));

import { nostrClient } from "@/services/nostrClient";

describe("nostr client relay normalization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not silently truncate subscriptions to five relays", () => {
    const relays = Array.from({ length: 8 }, (_, index) => `wss://relay-${index}.example`);
    nostrClient.subscribe([...relays, relays[0]], [{ kinds: [1059] }]);
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(mocks.subscribe.mock.calls[0][0]).toEqual(relays);
  });
});
