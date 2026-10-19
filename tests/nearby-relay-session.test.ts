import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const MANAGED = "wss://cloudflare-nostr-relay.noster.workers.dev";
const relay = vi.hoisted(() => ({
  cached: null as null | { token: string; expiresAt: number },
  issued: 0,
  sockets: {} as Record<string, { close: ReturnType<typeof import("vitest").vi.fn> }>,
}));

vi.mock("@/services/relaySession", () => ({
  managedRelayUrlFromCache: () => MANAGED,
  cachedManagedRelaySession: (url: string) => (url === MANAGED ? relay.cached : null),
  getManagedRelaySessionForUrl: vi.fn(async (_url: string, force = false) => {
    if (force || !relay.cached) relay.cached = { token: `nrs_${++relay.issued}`, expiresAt: Math.floor(Date.now() / 1000) + 600 };
    return relay.cached;
  }),
}));
vi.mock("trystero", () => ({ getRelaySockets: () => relay.sockets }));

import { prepareNearbyRelaySession } from "@/services/nearbyTransfer";
import { getManagedRelaySessionForUrl } from "@/services/relaySession";

type Hooks = { __haineiRelaySocketProtocols: (url: string) => string[] | undefined; __haineiRelayRecoverable: (url: string) => boolean };
const hooks = globalThis as unknown as Hooks;

beforeEach(() => {
  vi.useFakeTimers();
  relay.cached = null;
  relay.issued = 0;
  relay.sockets = {};
});
afterEach(() => vi.useRealTimers());

describe("nearby signaling on HaiNei's own relay", () => {
  it("patches Trystero to ask the app for socket subprotocols and to keep token relays", () => {
    expect(readFileSync("node_modules/@trystero-p2p/core/dist/utils.mjs", "utf8")).toContain("new WebSocket(url, globalThis.__haineiRelaySocketProtocols?.(url))");
    expect(readFileSync("node_modules/@trystero-p2p/nostr/dist/index.mjs", "utf8")).toContain("!globalThis.__haineiRelayRecoverable?.(client.url)");
  });

  it("offers the cached session token only to the managed relay", async () => {
    expect(hooks.__haineiRelaySocketProtocols(MANAGED)).toBeUndefined();
    await prepareNearbyRelaySession();
    expect(hooks.__haineiRelaySocketProtocols(MANAGED)).toEqual(["nostr", "relay-app.nrs_1"]);
    expect(hooks.__haineiRelaySocketProtocols("wss://nostr.dzo-hadar.ts.net")).toBeUndefined();
    expect(hooks.__haineiRelayRecoverable(`${MANAGED}/`)).toBe(true);
    expect(hooks.__haineiRelayRecoverable("wss://nostr.dzo-hadar.ts.net")).toBe(false);
  });

  it("renews the token before it lapses and reconnects so Trystero uses the new one", async () => {
    await prepareNearbyRelaySession();
    const socket = { close: vi.fn() };
    relay.sockets = { [MANAGED]: socket };
    await vi.advanceTimersByTimeAsync(600_000 - 61_000);
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getManagedRelaySessionForUrl).toHaveBeenLastCalledWith(MANAGED, true);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(hooks.__haineiRelaySocketProtocols(MANAGED)).toEqual(["nostr", "relay-app.nrs_2"]);
  });

  it("recycles a socket that was opened without a token once one is available", async () => {
    const socket = { close: vi.fn() };
    relay.sockets = { [MANAGED]: socket };
    await prepareNearbyRelaySession(true);
    expect(socket.close).toHaveBeenCalledOnce();
    await prepareNearbyRelaySession(true);
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
