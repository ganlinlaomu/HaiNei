import { HttpError, type Env } from "./types";
import { consumeRateLimit, requestSourceFingerprint } from "./requestGuards";

const HEX = /^[0-9a-f]{32}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/; // P-256 uncompressed point, base64url
const TOKEN = /^[0-9a-f]{64}$/;
const SEALED = /^[A-Za-z0-9_-]{50,1024}$/;
const IV = /^[A-Za-z0-9_-]{16}$/;
const TTL = 300;

type Pair = {
  id: string; receiver_key: string; poll_token_hash: string;
  sender_key: string | null; sender_pubkey: string | null;
  ciphertext: string | null; iv: string | null;
  state: string; expires_at: number;
};
const now = () => Math.floor(Date.now() / 1000);
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
const random = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
async function sha(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
function read(value: unknown, pattern: RegExp, name: string) {
  if (typeof value !== "string" || !pattern.test(value)) throw new HttpError(400, "invalid_" + name);
  return value;
}
async function pair(env: Env, id: unknown) {
  const record = await env.DB.prepare("SELECT * FROM hainei_device_pairs WHERE id = ?")
    .bind(read(id, HEX, "pair_id")).first<Pair>();
  if (!record || record.expires_at <= now() || record.state === "cancelled" || record.state === "consumed") {
    throw new HttpError(410, "pair_expired");
  }
  return record;
}
async function publicLimit(env: Env, request: Request, action: string, limit: number) {
  const source = await requestSourceFingerprint(request);
  await consumeRateLimit(env, `device_pair:${action}:${source}`, limit, 60);
}
export async function createDevicePair(env: Env, request: Request, receiverKey: unknown) {
  await publicLimit(env, request, "create", 8);
  const receiver = read(receiverKey, PUBLIC_KEY, "receiver_key");
  // Opportunistic bounded cleanup; abandoned sessions expire without background cron.
  void env.DB.prepare("DELETE FROM hainei_device_pairs WHERE expires_at < ?")
    .bind(now() - 300).run().catch(() => {});
  const id = random(16);
  const token = random(32);
  const expiresAt = now() + TTL;
  await env.DB.prepare(`INSERT INTO hainei_device_pairs
    (id, receiver_key, poll_token_hash, state, created_at, expires_at)
    VALUES (?, ?, ?, 'pending', ?, ?)`)
    .bind(id, receiver, await sha(token), now(), expiresAt).run();
  return { id, pollToken: token, expiresAt };
}
async function authenticatedReceiver(env: Env, request: Request, id: unknown, token: unknown) {
  await publicLimit(env, request, "receive", 60);
  const record = await pair(env, id);
  const pollToken = read(token, TOKEN, "poll_token");
  if (await sha(pollToken) !== record.poll_token_hash) throw new HttpError(403, "invalid_pair_secret");
  return record;
}
export async function pollDevicePair(env: Env, request: Request, id: unknown, token: unknown) {
  const record = await authenticatedReceiver(env, request, id, token);
  return {
    state: record.state,
    senderKey: record.sender_key,
    senderPubkey: record.sender_pubkey,
    ciphertext: record.ciphertext,
    iv: record.iv,
    expiresAt: record.expires_at,
  };
}
export async function offerDevicePair(env: Env, account: string, id: unknown, senderKey: unknown, receiverKey: unknown) {
  const record = await pair(env, id);
  if (record.receiver_key !== read(receiverKey, PUBLIC_KEY, "receiver_key")) throw new HttpError(409, "receiver_key_mismatch");
  const sender = read(senderKey, PUBLIC_KEY, "sender_key");
  const result = await env.DB.prepare(`UPDATE hainei_device_pairs
    SET sender_key = ?, sender_pubkey = ?, state = 'offered'
    WHERE id = ? AND state = 'pending' AND expires_at > ?`)
    .bind(sender, account, record.id, now()).run();
  if (result.meta?.changes !== 1) throw new HttpError(409, "pair_already_claimed");
  return { accepted: true, expiresAt: record.expires_at };
}
export async function deliverDevicePair(env: Env, account: string, id: unknown, ciphertext: unknown, iv: unknown) {
  const record = await pair(env, id);
  const sealed = read(ciphertext, SEALED, "ciphertext");
  const nonce = read(iv, IV, "iv");
  if (record.sender_pubkey !== account) throw new HttpError(403, "wrong_pair_sender");
  const result = await env.DB.prepare(`UPDATE hainei_device_pairs
    SET ciphertext = ?, iv = ?, state = 'delivered'
    WHERE id = ? AND state = 'offered' AND sender_pubkey = ? AND expires_at > ?`)
    .bind(sealed, nonce, record.id, account, now()).run();
  if (result.meta?.changes !== 1) throw new HttpError(409, "pair_not_offered");
  return { accepted: true };
}
export async function finishDevicePair(env: Env, request: Request, id: unknown, token: unknown, cancel: boolean) {
  const record = await authenticatedReceiver(env, request, id, token);
  if (!cancel && record.state !== "delivered") throw new HttpError(409, "pair_not_delivered");
  const result = await env.DB.prepare(`UPDATE hainei_device_pairs
    SET ciphertext = NULL, iv = NULL, state = ?
    WHERE id = ? AND state = ? AND expires_at > ?`)
    .bind(cancel ? "cancelled" : "consumed", record.id, record.state, now()).run();
  if (result.meta?.changes !== 1) throw new HttpError(409, "pair_state_changed");
  return { accepted: true };
}
