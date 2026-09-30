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

export async function signWorkerRequest(
  signEvent: WorkerSignEvent,
  accountPubkey: string,
  options: {
    action: string;
    challenge: string;
    expiresAt: number;
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
      ["challenge", options.challenge],
      ["expiration", String(Math.min(options.expiresAt || now + 300, now + 300))],
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
