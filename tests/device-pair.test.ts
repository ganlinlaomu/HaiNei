import { describe, expect, it } from "vitest";
import { getPublicKey, utils } from "nostr-tools";
import {
  makePairKeys, pairingCode, sealKey, openKey, pairLink, parsePairLink, type PairSession,
} from "@/services/devicePairing";

const sk = "1".repeat(64);
const account = getPublicKey(utils.hexToBytes(sk));
describe("QR device handoff cryptography", () => {
  it("matches SAS codes and decrypts only on the intended new device", async () => {
    const receiver = await makePairKeys();
    const sender = await makePairKeys();
    const id = "b".repeat(32);
    const left = await pairingCode(receiver.privateKey, sender.publicKey, id);
    const right = await pairingCode(sender.privateKey, receiver.publicKey, id);
    expect(left).toBe(right);
    expect(left).toMatch(/^\d{6}$/);
    const sealed = await sealKey(sender.privateKey, receiver.publicKey, id, sk, account);
    expect(sealed.ciphertext).not.toContain(sk);
    expect(await openKey(receiver.privateKey, sender.publicKey, id, sealed.ciphertext, sealed.iv, account)).toBe(sk);
    const attacker = await makePairKeys();
    await expect(openKey(attacker.privateKey, sender.publicKey, id, sealed.ciphertext, sealed.iv, account)).rejects.toThrow();
  });
  it("binds ciphertext to pairing ID and account identity", async () => {
    const receiver = await makePairKeys();
    const sender = await makePairKeys();
    const id = "f".repeat(32);
    const encrypted = await sealKey(sender.privateKey, receiver.publicKey, id, sk, account);
    await expect(openKey(receiver.privateKey, sender.publicKey, "a".repeat(32),
      encrypted.ciphertext, encrypted.iv, account)).rejects.toThrow();
    await expect(openKey(receiver.privateKey, sender.publicKey, id,
      encrypted.ciphertext, encrypted.iv, "2".repeat(64))).rejects.toThrow();
    await expect(sealKey(sender.privateKey, receiver.publicKey, id, sk, "2".repeat(64))).rejects.toThrow();
  });
  it("recognizes only same-origin pairing links, never a profile QR or foreign URL", async () => {
    const receiver = await makePairKeys();
    const session: PairSession = { id: "a".repeat(32), pollToken: "c".repeat(64),
      receiverKey: receiver.publicKey, expiresAt: Math.floor(Date.now() / 1000) + 300 };
    const oldWindow = globalThis.window;
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { location: {
        origin: "https://hainei.example", pathname: "/",
      } } });
      const link = pairLink(session);
      expect(parsePairLink(link)).toEqual({ id: session.id, receiverKey: session.receiverKey });
      expect(link).not.toContain(session.pollToken);
      expect(parsePairLink(link.replace("https://hainei.example", "https://other.example"))).toBe(null);
      expect(parsePairLink("nostr:npub1deadbeef")).toBe(null);
      // The Android app shows its QR from https://localhost; the web app must still accept it.
      const appLink = link.replace("https://hainei.example", "https://localhost");
      expect(parsePairLink(appLink)).toEqual({ id: session.id, receiverKey: session.receiverKey });
      expect(parsePairLink(appLink.replace("https://", "http://"))).toBe(null);
      // The app has no web origin, so it accepts the web app's QR from any https host, but not http.
      expect(parsePairLink(link, "https://localhost")).toEqual({ id: session.id, receiverKey: session.receiverKey });
      expect(parsePairLink(link.replace("https://", "http://"), "https://localhost")).toBe(null);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: oldWindow });
    }
  });
});
