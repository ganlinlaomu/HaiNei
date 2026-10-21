// Arrival-time catch-up is only used once the managed relay advertises the
// received_since filter extension in NIP-11; other relays ignore the field.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceStorage } from "@/services/deviceStorage";
import { managedReceivedSinceRelay, resetManagedRelaySessionForTests } from "@/services/relaySession";

const RELAY = "wss://relay.example";

function relayInfo(body: unknown, ok = true) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  deviceStorage.removeItem("hainei_relay_received_since");
  deviceStorage.removeItem("hainei_managed_relay_url");
  resetManagedRelaySessionForTests();
});

describe("received_since relay support", () => {
  it("returns the managed relay only when NIP-11 advertises the extension, and caches the answer", async () => {
    deviceStorage.setItem("hainei_managed_relay_url", RELAY);
    const fetchMock = relayInfo({ name: "relay", received_since: true });
    vi.stubGlobal("fetch", fetchMock);
    expect(await managedReceivedSinceRelay()).toBe(RELAY);
    expect(fetchMock).toHaveBeenCalledWith("https://relay.example", expect.objectContaining({ headers: { Accept: "application/nostr+json" } }));
    expect(await managedReceivedSinceRelay()).toBe(RELAY);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A fresh session reads the per-device cache instead of fetching again.
    resetManagedRelaySessionForTests();
    expect(await managedReceivedSinceRelay()).toBe(RELAY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the regular catch-up without the flag, offline, or with no managed relay", async () => {
    expect(await managedReceivedSinceRelay()).toBe("");
    deviceStorage.setItem("hainei_managed_relay_url", RELAY);
    vi.stubGlobal("fetch", relayInfo({ name: "relay" }));
    expect(await managedReceivedSinceRelay()).toBe("");
    resetManagedRelaySessionForTests();
    deviceStorage.removeItem("hainei_relay_received_since");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await managedReceivedSinceRelay()).toBe("");
  });
});

describe("relay NIP-77 support", () => {
  it("reads supported_nips from NIP-11 once a day and treats failures as unsupported", async () => {
    const { negentropyCapableRelays, resetRelayCapabilitiesForTests } = await import("@/services/relayCapabilities");
    resetRelayCapabilitiesForTests();
    deviceStorage.removeItem("hainei_relay_nips");
    const fetchMock = vi.fn(async (url: string) => url.includes("strfry")
      ? new Response(JSON.stringify({ supported_nips: [1, 11, 77] }))
      : url.includes("down") ? Promise.reject(new TypeError("offline")) : new Response(JSON.stringify({ supported_nips: [1, 11] })));
    vi.stubGlobal("fetch", fetchMock);
    const relays = ["wss://strfry.example", "wss://plain.example", "wss://down.example"];
    expect(await negentropyCapableRelays(relays)).toEqual(["wss://strfry.example"]);
    expect(await negentropyCapableRelays(relays)).toEqual(["wss://strfry.example"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    deviceStorage.removeItem("hainei_relay_nips");
  });
});
