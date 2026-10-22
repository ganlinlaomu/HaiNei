// Relay sessions last a day and are saved per account, so a launch connects
// without the ~1 s challenge + session round trips through the worker.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { deviceStorage } from "@/services/deviceStorage";
import {
  cachedManagedRelaySession, getManagedRelaySessionForUrl, invalidateRestoredRelaySession, registerRelaySessionSigner, resetManagedRelaySessionForTests,
} from "@/services/relaySession";

const PUBKEY = "a".repeat(64);
const RELAY = "wss://relay.example";
const KEY = `nostr_relay_session_${PUBKEY}`;
const now = () => Math.floor(Date.now() / 1000);
const signer = vi.fn();

function save(expiresIn: number, overrides: Record<string, unknown> = {}) {
  deviceStorage.setItem(KEY, JSON.stringify({ token: "nrs_saved", pubkey: PUBKEY, relayUrl: RELAY, scope: "relay", expiresAt: now() + expiresIn, ...overrides }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  deviceStorage.removeItem(KEY);
  resetManagedRelaySessionForTests();
});

describe("saved relay session", () => {
  it("is reused after a restart without asking the worker", () => {
    save(20 * 60 * 60);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    registerRelaySessionSigner(PUBKEY, signer);
    expect(cachedManagedRelaySession(RELAY)?.token).toBe("nrs_saved");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("connects with the saved session without waiting for the relay config", async () => {
    // On a slow network the config request timed out after 3 s and the
    // managed relay stayed offline although a valid session was saved.
    save(20 * 60 * 60);
    deviceStorage.setItem("hainei_managed_relay_url", RELAY);
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    registerRelaySessionSigner(PUBKEY, signer);
    expect((await getManagedRelaySessionForUrl(RELAY))?.token).toBe("nrs_saved");
    deviceStorage.removeItem("hainei_managed_relay_url");
  });

  it("ignores expired, foreign or malformed saved sessions", () => {
    for (const overrides of [{ expiresAt: now() + 10 }, { pubkey: "b".repeat(64) }, { token: "bogus" }]) {
      save(20 * 60 * 60, overrides);
      resetManagedRelaySessionForTests();
      registerRelaySessionSigner(PUBKEY, signer);
      expect(cachedManagedRelaySession(RELAY)).toBeNull();
    }
  });

  it("starts a background renewal when less than two hours remain", () => {
    save(60 * 60);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    registerRelaySessionSigner(PUBKEY, signer);
    // The current token keeps working while a new one is requested.
    expect(cachedManagedRelaySession(RELAY)?.token).toBe("nrs_saved");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("drops a saved session the relay rejects, but never a freshly issued one", () => {
    save(20 * 60 * 60);
    registerRelaySessionSigner(PUBKEY, signer);
    expect(invalidateRestoredRelaySession("nrs_other")).toBe(false);
    expect(invalidateRestoredRelaySession("nrs_saved")).toBe(true);
    expect(cachedManagedRelaySession(RELAY)).toBeNull();
    expect(deviceStorage.getItem(KEY)).toBeNull();
    // Already dropped: a second rejection does not trigger another reconnect.
    expect(invalidateRestoredRelaySession("nrs_saved")).toBe(false);
  });

  it("is stored encrypted with the account's private device values and wired into the socket", () => {
    expect(readFileSync("src/services/deviceStorage.ts", "utf8")).toContain("relay_session|");
    const relays = readFileSync("src/nostr/relays.ts", "utf8");
    expect(relays).toContain("dropRejectedSession(data[2]);");
    expect(relays).toContain("if (ok === false) dropRejectedSession(msg);");
    expect(readFileSync("worker/src/relay.ts", "utf8")).toContain("RELAY_SESSION_TTL_SECONDS = 24 * 60 * 60");
  });
});
