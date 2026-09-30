import { verifyEvent } from "nostr-tools";
import type { Event } from "nostr-tools/core";
import { HttpError, integerSetting, type Env } from "./types";
import { consumeRateLimit } from "./requestGuards";

const PUBKEY = /^[0-9a-f]{64}$/;
const CHALLENGE = /^[0-9a-f]{64}$/;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function tagValues(event: Event, name: string) {
  return event.tags.filter(tag => tag[0] === name).map(tag => tag[1]);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

async function payloadHash(payload: Record<string, unknown>) {
  return sha256(stableJson(payload));
}

export type WorkerAuthBinding = {
  url: string;
  method: string;
  payload: Record<string, unknown>;
};

export async function createChallenge(env: Env, now = Math.floor(Date.now() / 1000)) {
  // Keep the challenge table bounded even when clients abandon handshakes.
  void env.DB.prepare(`
    DELETE FROM hainei_auth_challenges
    WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)
  `).bind(now, now - 3600).run().catch(() => {});
  const challenge = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + integerSetting(env.AUTH_CHALLENGE_TTL_SECONDS, 300, 60, 600);
  await env.DB.prepare(`
    INSERT INTO hainei_auth_challenges
      (challenge_hash, pubkey, created_at, expires_at, used_at)
    VALUES (?, NULL, ?, ?, NULL)
  `).bind(await sha256(challenge), now, expiresAt).run();
  return { challenge, expiresAt };
}

export async function verifyAndConsumeChallenge(
  env: Env,
  challengeValue: unknown,
  eventValue: unknown,
  now = Math.floor(Date.now() / 1000),
  expectedAction = "hainei_media_session",
  binding?: WorkerAuthBinding,
) {
  const challenge = typeof challengeValue === "string" ? challengeValue.trim().toLowerCase() : "";
  if (!CHALLENGE.test(challenge)) throw new HttpError(400, "invalid_challenge");
  const event = eventValue as Event;
  if (!event || event.kind !== 27235 || !PUBKEY.test(event.pubkey || "") || !verifyEvent(event)) {
    throw new HttpError(401, "invalid_nostr_signature");
  }
  if (event.created_at > now + 60 || event.created_at < now - 600) {
    throw new HttpError(401, "invalid_event_time");
  }
  const actions = tagValues(event, "t");
  const challenges = tagValues(event, "challenge");
  const expirations = tagValues(event, "expiration");
  if (actions.length !== 1 || actions[0] !== expectedAction) {
    throw new HttpError(401, "invalid_auth_action");
  }
  if (challenges.length !== 1 || challenges[0] !== challenge) {
    throw new HttpError(401, "challenge_mismatch");
  }
  if (expirations.length !== 1 || !/^\d+$/.test(expirations[0]) || Number(expirations[0]) <= now) {
    throw new HttpError(401, "auth_event_expired");
  }

  if (binding) {
    const urls = tagValues(event, "u");
    const methods = tagValues(event, "method");
    const payloads = tagValues(event, "payload");
    const expectedUrl = binding.url;
    const expectedMethod = binding.method.toUpperCase();
    const expectedPayload = await payloadHash(binding.payload);
    if (urls.length !== 1 || urls[0] !== expectedUrl) throw new HttpError(401, "auth_url_mismatch");
    if (methods.length !== 1 || methods[0]?.toUpperCase() !== expectedMethod) throw new HttpError(401, "auth_method_mismatch");
    if (payloads.length !== 1 || payloads[0] !== expectedPayload) throw new HttpError(401, "auth_payload_mismatch");
  }

  const authLimit = integerSetting(env.AUTH_REQUESTS_PER_MINUTE_PER_PUBKEY, 120, 10, 2000);
  await consumeRateLimit(env, `auth:${expectedAction}:${event.pubkey}`, authLimit, 60, now);

  const challengeHash = await sha256(challenge);
  const record = await env.DB.prepare(`
    SELECT expires_at, used_at FROM hainei_auth_challenges WHERE challenge_hash = ?
  `).bind(challengeHash).first<{ expires_at: number; used_at: number | null }>();
  if (!record) throw new HttpError(400, "invalid_challenge");
  if (record.used_at !== null) throw new HttpError(409, "challenge_already_used");
  if (Number(record.expires_at) <= now) throw new HttpError(410, "challenge_expired");

  const consumed = await env.DB.prepare(`
    UPDATE hainei_auth_challenges SET used_at = ?, pubkey = ?
    WHERE challenge_hash = ? AND used_at IS NULL AND expires_at > ?
  `).bind(now, event.pubkey, challengeHash, now).run();
  if (Number(consumed.meta?.changes || 0) !== 1) throw new HttpError(409, "challenge_already_used");
  return event.pubkey;
}
