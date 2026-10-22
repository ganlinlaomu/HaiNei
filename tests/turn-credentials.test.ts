// Cloudflare TURN for WebRTC peers that cannot reach each other directly.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createTurnCredentials, normalizeIceServers } from "../worker/src/turn";
import { deviceStorage } from "@/services/deviceStorage";
import { registerRelaySessionSigner, resetManagedRelaySessionForTests, resetTurnCredentialsForTests, turnIceServers } from "@/services/relaySession";

const PUBKEY = "a".repeat(64);
const signer = vi.fn(async (event: any) => ({ ...event, pubkey: PUBKEY, id: "e".repeat(64), sig: "f".repeat(128) }));
const env = (overrides: Record<string, unknown> = {}) => ({
  DB: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => ({ count: 1 }) }) }) },
  TURN_KEY_ID: "key-id", TURN_KEY_API_TOKEN: "secret", ...overrides,
}) as any;

afterEach(() => {
  vi.unstubAllGlobals();
  deviceStorage.removeItem(`nostr_turn_servers_${PUBKEY}`);
  resetTurnCredentialsForTests();
  resetManagedRelaySessionForTests();
});

describe("worker TURN credentials", () => {
  it("keeps usable servers and drops port 53, which browsers refuse", () => {
    expect(normalizeIceServers({ iceServers: [
      { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
    ] })).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
    ]);
    // The older single-object response shape.
    expect(normalizeIceServers({ iceServers: { urls: ["turn:x:3478"], username: "u", credential: "c" } })).toHaveLength(1);
  });

  it("issues short-lived credentials with the server-side key, or reports it unconfigured", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createTurnCredentials(env(), PUBKEY, 1_000);
    expect(result).toEqual({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }], expiresAt: 1_000 + 12 * 3600 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    await expect(createTurnCredentials(env({ TURN_KEY_ID: undefined }), PUBKEY)).rejects.toMatchObject({ status: 503, message: "turn_not_configured" });
    // The key never reaches the client bundle.
    expect(readFileSync("src/services/relaySession.ts", "utf8")).not.toContain("TURN_KEY_API_TOKEN");
    expect(readFileSync("worker/src/index.ts", "utf8")).toContain('"hainei_turn"');
  });
});

describe("client TURN servers", () => {
  it("fetches once per account and reuses the cached set", async () => {
    const iceServers = [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ iceServers, expiresAt: Math.floor(Date.now() / 1000) + 12 * 3600 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    registerRelaySessionSigner(PUBKEY, signer as any);
    expect(await turnIceServers()).toEqual(iceServers);
    expect(await turnIceServers()).toEqual(iceServers);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toMatch(/\/api\/turn\/credentials$/);
  });

  it("returns no servers (direct only) when TURN is unavailable, and backs off", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "turn_not_configured" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    registerRelaySessionSigner(PUBKEY, signer as any);
    expect(await turnIceServers()).toEqual([]);
    expect(await turnIceServers()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("is passed to the file transfer's WebRTC config without delaying the join", () => {
    const nearby = readFileSync("src/services/nearbyTransfer.ts", "utf8");
    expect(nearby).toContain("rtcConfig: { iceServers: [...ICE_SERVERS, ...turn] }");
    expect(nearby).toContain("turnServersWithin(TURN_WAIT_MS)");
    expect(nearby).toContain("clearTimeout(timer); resolve(servers);");
  });
});
