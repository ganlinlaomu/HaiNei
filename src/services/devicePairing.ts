import { getPublicKey, utils } from "nostr-tools";
import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { signWorkerRequest } from "@/services/workerAuth";
import { haineiWorkerBaseUrl } from "@/services/workerUrl";
import { timedJsonFetch } from "@/utils/timedFetch";

const P256_LENGTH = 65;
const HEX_ID = /^[0-9a-f]{32}$/;
const B64 = /^[A-Za-z0-9_-]{87}$/;
const encoder = new TextEncoder();

export type PairKeys = { privateKey: CryptoKey; publicKey: string };
export type PairSession = { id: string; pollToken: string; expiresAt: number; receiverKey: string };
export type PairSnapshot = {
  state: "pending" | "offered" | "delivered";
  senderKey: string | null; senderPubkey: string | null;
  ciphertext: string | null; iv: string | null; expiresAt: number;
};
export type PairSigner = { pkHex: string; signEvent: (event: EventTemplate) => Promise<VerifiedEvent> };
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("invalid_pair_encoding");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export async function makePairKeys(): Promise<PairKeys> {
  // The ephemeral private key is non-extractable and only lives in this tab.
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicKey: encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))) };
}
export function parsePairLink(value: string, origin = window.location.origin): { id: string; receiverKey: string } | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== origin || url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) return null;
  const hash = url.hash.replace(/^#/, "");
  let relative: URL;
  try { relative = new URL(hash, url.origin); } catch { return null; }
  if (relative.pathname !== "/device-pair") return null;
  const raw = relative.searchParams.get("pair") || "";
  const parts = raw.split(".");
  if (parts.length !== 2 || !HEX_ID.test(parts[0]) || !B64.test(parts[1])) return null;
  return { id: parts[0], receiverKey: parts[1] };
}
export function pairLink(session: PairSession): string {
  return `${window.location.origin}${window.location.pathname}#/device-pair?pair=${session.id}.${session.receiverKey}`;
}
function endpoint(path: string) {
  const base = haineiWorkerBaseUrl();
  if (!base) throw new Error("海内 Worker 未配置，无法进行设备接力");
  return `${base}/api/device-pair/${path}`;
}
async function json(response: Response): Promise<any> {
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(value?.error || `pair_http_${response.status}`));
  return value;
}
async function post(path: string, payload: Record<string, unknown>) {
  return json(await timedJsonFetch(endpoint(path), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, 8_000));
}
async function signedPost(path: string, signer: PairSigner, payload: Record<string, unknown>) {
  const account = signer.pkHex;
  const challenge = await postChallenge();
  if (signer.pkHex !== account) throw new Error("account_changed");
  const event = await signWorkerRequest(signer.signEvent.bind(signer), account, {
    action: "hainei_device_pair", challenge: challenge.challenge, expiresAt: challenge.expiresAt,
    url: endpoint(path), method: "POST", payload,
    content: "Authorize one-time encrypted HaiNei device pairing",
  });
  if (signer.pkHex !== account) throw new Error("account_changed");
  return post(path, { ...payload, challenge: challenge.challenge, event });
}
async function postChallenge(): Promise<{ challenge: string; expiresAt: number }> {
  return json(await timedJsonFetch(`${haineiWorkerBaseUrl()}/api/auth/challenge`, { method: "POST" }));
}
export async function createPair(receiverKey: string): Promise<PairSession> {
  if (!B64.test(receiverKey) || decode(receiverKey).length !== P256_LENGTH) throw new Error("invalid_pair_key");
  const result = await post("create", { receiverKey });
  return { id: result.id, pollToken: result.pollToken, expiresAt: result.expiresAt, receiverKey };
}
export function pollPair(session: PairSession): Promise<PairSnapshot> {
  return post("poll", { id: session.id, pollToken: session.pollToken });
}
export function offerPair(signer: PairSigner, id: string, receiverKey: string, senderKey: string) {
  return signedPost("offer", signer, { id, receiverKey, senderKey });
}
export function deliverPair(signer: PairSigner, id: string, ciphertext: string, iv: string) {
  return signedPost("deliver", signer, { id, ciphertext, iv });
}
export function endPair(session: PairSession, cancel = false) {
  return post(cancel ? "cancel" : "ack", { id: session.id, pollToken: session.pollToken });
}
async function secret(privateKey: CryptoKey, otherKey: string): Promise<ArrayBuffer> {
  if (!B64.test(otherKey)) throw new Error("invalid_remote_pair_key");
  const raw = decode(otherKey);
  if (raw.length !== P256_LENGTH || raw[0] !== 4) throw new Error("invalid_remote_pair_key");
  const peer = await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  return crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
}
async function material(privateKey: CryptoKey, remoteKey: string, id: string): Promise<{ key: CryptoKey; code: string }> {
  if (!HEX_ID.test(id)) throw new Error("invalid_pair_id");
  const shared = await secret(privateKey, remoteKey);
  const raw = new Uint8Array(shared);
  const salt = await crypto.subtle.digest("SHA-256", encoder.encode("hainei-device-pair-v1:" + id));
  const input = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("hainei-device-transfer-aes-gcm-v1"),
  }, input, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const check = new Uint8Array(raw.length + 32);
  check.set(raw);
  check.set(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(id))), raw.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", check));
  const numeric = (((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 1_000_000);
  return { key, code: String(numeric).padStart(6, "0") };
}
export async function pairingCode(ownKey: CryptoKey, otherKey: string, id: string): Promise<string> {
  return (await material(ownKey, otherKey, id)).code;
}
export async function sealKey(ownKey: CryptoKey, receiverKey: string, id: string, skHex: string, pubkey: string) {
  if (!/^[0-9a-f]{64}$/.test(skHex) || getPublicKey(utils.hexToBytes(skHex)) !== pubkey) {
    throw new Error("pair_account_mismatch");
  }
  const { key } = await material(ownKey, receiverKey, id);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({ version: 1, id, pubkey, skHex }));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(id) }, key, plaintext);
  return { ciphertext: encode(new Uint8Array(encrypted)), iv: encode(iv) };
}
export async function openKey(ownKey: CryptoKey, senderKey: string, id: string, ciphertext: string, ivText: string, senderPubkey: string) {
  const iv = decode(ivText);
  if (iv.length !== 12) throw new Error("invalid_pair_nonce");
  const { key } = await material(ownKey, senderKey, id);
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(id) }, key, decode(ciphertext));
  const decoded = JSON.parse(new TextDecoder().decode(bytes)) as { version: number; id: string; pubkey: string; skHex: string };
  if (decoded.version !== 1 || decoded.id !== id || decoded.pubkey !== senderPubkey ||
      !/^[0-9a-f]{64}$/.test(decoded.skHex) || getPublicKey(utils.hexToBytes(decoded.skHex)) !== senderPubkey) {
    throw new Error("pair_identity_mismatch");
  }
  return decoded.skHex;
}
