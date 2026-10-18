import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NEARBY_MAX_BATCH_BYTES,
  batchBytes,
  defaultDeviceName,
  ownDevicesRoom,
  pairingLink,
  parsePairing,
  randomPairingRoom,
  sanitizeOffer,
} from "@/services/nearbyTransfer";

const KEY_A = "1".repeat(64);
const KEY_B = "2".repeat(64);

describe("附近传输 rooms", () => {
  it("puts every device of one account in the same secret room, and other accounts elsewhere", async () => {
    const first = await ownDevicesRoom(KEY_A);
    expect(await ownDevicesRoom(KEY_A.toUpperCase())).toEqual(first);
    expect(await ownDevicesRoom(KEY_B)).not.toEqual(first);
    // Neither the room nor its password reveals the key or each other.
    expect(first.roomId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.password).not.toBe(first.roomId);
    expect(first.roomId).not.toContain(KEY_A);
    await expect(ownDevicesRoom("not-a-key")).rejects.toThrow();
  });

  it("round-trips one-time pairing links", () => {
    const room = randomPairingRoom();
    expect(room.roomId).toMatch(/^[0-9a-f]{32}$/);
    expect(randomPairingRoom()).not.toEqual(room);
    const link = pairingLink(room, "https://hainei.example");
    expect(link).toBe(`https://hainei.example/#/nearby?pair=${room.roomId}.${room.password}`);
    expect(parsePairing(link)).toEqual(room);
    expect(parsePairing(`${room.roomId}.${room.password}`)).toEqual(room);
    expect(parsePairing("nostr:npub1abc")).toBeNull();
  });

  it("names devices in everyday words", () => {
    expect(defaultDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(defaultDeviceName("Mozilla/5.0 (Linux; Android 15) Mobile")).toBe("Android 手机");
    expect(defaultDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows 电脑");
    expect(defaultDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe("Mac");
    expect(defaultDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("iPad");
  });
});

describe("incoming offers", () => {
  it("accepts well-formed offers and strips path separators from names", () => {
    const offer = sanitizeOffer({ id: "0123456789abcdef", files: [{ name: "../照片/a.jpg", size: 10, type: "image/jpeg" }] }, "peer");
    expect(offer).toEqual({ id: "0123456789abcdef", from: "peer", files: [{ name: ".._照片_a.jpg", size: 10, type: "image/jpeg" }] });
  });

  it("rejects malformed offers", () => {
    expect(sanitizeOffer(null, "peer")).toBeNull();
    expect(sanitizeOffer({ id: "short", files: [{ name: "a", size: 1 }] }, "peer")).toBeNull();
    expect(sanitizeOffer({ id: "0123456789abcdef", files: [] }, "peer")).toBeNull();
  });

  it("caps one batch at 1GB for iPhone memory", () => {
    expect(NEARBY_MAX_BATCH_BYTES).toBe(1024 * 1024 * 1024);
    expect(batchBytes([{ size: 600 * 1024 * 1024 }, { size: 500 * 1024 * 1024 }])).toBeGreaterThan(NEARBY_MAX_BATCH_BYTES);
  });

  it("asks before receiving and refuses bytes that were not accepted", () => {
    const service = readFileSync("src/services/nearbyTransfer.ts", "utf8");
    expect(service).toContain('kind: "request"');
    expect(service).toContain("return !!entry && entry.from === peerId && !!announced && byteLength <= announced.size + 1024;");
  });
});

describe("integration", () => {
  it("is reachable without an account, linked from 我的, and loads Trystero lazily", () => {
    const router = readFileSync("src/router/index.ts", "utf8");
    expect(router).toContain('const NearbyTransfer = () => import("@/views/NearbyTransfer.vue");');
    expect(router).toMatch(/path: "\/nearby",[\s\S]{0,80}requiresAuth: false/);
    expect(readFileSync("src/views/Settings.vue", "utf8")).toContain("router.push('/nearby')");
    const service = readFileSync("src/services/nearbyTransfer.ts", "utf8");
    expect(service).toContain('await import("trystero")');
    expect(service).not.toMatch(/^import \{[^}]*\} from "trystero";/m);
  });
});
