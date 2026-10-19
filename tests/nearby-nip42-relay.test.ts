import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyEvent } from "nostr-tools";

type NostrAuthEvent = {
  id: string;
  pubkey: string;
  sig: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

describe("Trystero NIP-42 signaling authentication", () => {
  it("signs a valid relay-specific AUTH event with Trystero's ephemeral session key", async () => {
    // The postinstall patch deliberately does not require the HaiNei private key.
    const nostr = await import("@trystero-p2p/nostr");
    const createAuthEvent = (nostr as unknown as {
      createNearbyNip42AuthEvent: (challenge: string, relay: string) => Promise<NostrAuthEvent>;
    }).createNearbyNip42AuthEvent;

    expect(createAuthEvent).toBeTypeOf("function");
    const relay = "wss://cloudflare-nostr-relay.noster.workers.dev";
    const event = await createAuthEvent("relay-nonce-123", relay);
    expect(event.kind).toBe(22242);
    expect(event.content).toBe("");
    expect(event.tags).toEqual([["relay", relay], ["challenge", "relay-nonce-123"]]);
    expect(event.pubkey).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyEvent(event)).toBe(true);
    expect(event.created_at).toBeGreaterThan(Math.floor(Date.now() / 1000) - 60);
  });

  it("handles AUTH and its ACK without permanently retiring a pre-auth relay", () => {
    const source = readFileSync("node_modules/@trystero-p2p/nostr/dist/index.mjs", "utf8");
    expect(source).toContain("if (msgType === 'AUTH')");
    expect(source).toContain("handleNearbyNip42Challenge(client, subId)");
    expect(source).toContain("pendingAuth?.id === subId");
    expect(source).toContain("resubscribeOnReconnect(client)");
    expect(source).toContain("nearbyNip42PendingAcks.set(client");
    expect(source).toContain("/^(blocked|restricted|pow):/");
    expect(source).not.toContain("/^(blocked|restricted|auth-required|pow):/");
  });
});
