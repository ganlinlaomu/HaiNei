import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";

export type WorkerSignEvent = (event: EventTemplate) => Promise<VerifiedEvent>;

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

export function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function workerPayloadHash(payload: Record<string, unknown>) {
  return sha256Hex(stableJson(payload));
}

// The worker accepts a challenge-free request for this long after signing.
const SINGLE_TRIP_LIFETIME_SECONDS = 120;
// Refusals that mean "use a challenge instead": this device's clock is off,
// or the worker predates single-trip auth.
const CHALLENGE_FALLBACK_ERRORS = new Set(["auth_clock_skew", "invalid_event_time", "invalid_challenge", "challenge_mismatch", "auth_event_expired"]);
let preferChallenge = false;

export function resetWorkerAuthForTests() {
  preferChallenge = false;
}

export type SignedWorkerPostOptions = {
  action: string;
  url: string;
  payload: Record<string, unknown>;
  content: string;
  /** Sends `body` as the JSON request to `url`. */
  send: (body: Record<string, unknown>) => Promise<Response>;
  /** Fetches a one-time challenge, for the fallback. */
  challenge: () => Promise<{ challenge: string; expiresAt: number }>;
  /** Throws if the account or session changed while waiting. */
  ensureCurrent?: () => void;
};

/**
 * Authorize a worker request in one round trip: sign it bound to its URL,
 * method, payload and the current time. If the worker refuses that (clock
 * skew, or an older worker), repeat it once with a one-time challenge and
 * keep using challenges for the rest of this session.
 */
export async function signedWorkerPost(signEvent: WorkerSignEvent, accountPubkey: string, options: SignedWorkerPostOptions) {
  const sign = (challenge?: { challenge: string; expiresAt: number }) => signWorkerRequest(signEvent, accountPubkey, {
    action: options.action, url: options.url, method: "POST", payload: options.payload, content: options.content,
    ...(challenge ? { challenge: challenge.challenge, expiresAt: challenge.expiresAt } : {}),
  });
  if (!preferChallenge) {
    const event = await sign();
    options.ensureCurrent?.();
    const response = await options.send({ ...options.payload, event });
    if (response.status !== 400 && response.status !== 401) return response;
    const error = await response.clone().json().then(body => String(body?.error || ""), () => "");
    if (!CHALLENGE_FALLBACK_ERRORS.has(error)) return response;
    preferChallenge = true;
  }
  const challenge = await options.challenge();
  options.ensureCurrent?.();
  const event = await sign(challenge);
  options.ensureCurrent?.();
  return options.send({ ...options.payload, challenge: challenge.challenge, event });
}

export async function signWorkerRequest(
  signEvent: WorkerSignEvent,
  accountPubkey: string,
  options: {
    action: string;
    /** Omit to sign a single-trip, timestamp-bound request (see signedWorkerPost). */
    challenge?: string;
    expiresAt?: number;
    url: string;
    method?: string;
    payload: Record<string, unknown>;
    content: string;
  },
) {
  const now = Math.floor(Date.now() / 1000);
  const method = (options.method || "POST").toUpperCase();
  const payloadHash = await workerPayloadHash(options.payload);
  const event = await signEvent({
    kind: 27235,
    created_at: now,
    content: options.content,
    tags: [
      ["t", options.action],
      ...(options.challenge === undefined ? [] : [["challenge", options.challenge]]),
      ["expiration", String(options.challenge === undefined
        ? now + SINGLE_TRIP_LIFETIME_SECONDS
        : Math.min(options.expiresAt || now + 300, now + 300))],
      ["u", options.url],
      ["method", method],
      ["payload", payloadHash],
    ],
  });
  if (event.pubkey.toLowerCase() !== accountPubkey.toLowerCase()) {
    throw new Error("worker_auth_identity_mismatch");
  }
  return event;
}
