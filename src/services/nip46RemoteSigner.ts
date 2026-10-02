import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import type { RemoteSignerCredential } from "@/services/remoteSignerCredential";

const MAX_ACTIVE_OPERATIONS = 2;
const MAX_WAITING_OPERATIONS = 16;
const OPERATION_TIMEOUT_MS = 60_000;

type RemoteSignerLike = {
  close(): Promise<void>;
  connect(): Promise<void>;
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string>;
};

type Session = {
  signer: RemoteSignerLike;
  generation: number;
};

const sessions = new Map<string, Session>();
let generation = 0;
let activeOperations = 0;
const waitingOperations: Array<() => void> = [];

function hex(bytes: Uint8Array) {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function bytes(hexValue: string) {
  if (!/^[0-9a-f]{64}$/i.test(hexValue)) throw new Error("invalid_remote_signer_client_secret");
  return Uint8Array.from(hexValue.match(/../g)!, value => parseInt(value, 16));
}

function normalizePubkey(value: string, label = "remote_signer_pubkey") {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`invalid_${label}`);
  return normalized;
}

function normalizeRelays(relays: string[]) {
  const normalized = [...new Set(relays.map(value => value.trim()).filter(Boolean))];
  if (!normalized.length || normalized.length > 5) throw new Error("invalid_remote_signer_relays");
  return normalized.map(value => {
    const url = new URL(value);
    if (url.protocol !== "wss:") throw new Error("invalid_remote_signer_relay");
    return url.toString();
  });
}

function showAuthorization(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return;
    if (typeof window !== "undefined") {
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    }
  } catch {
    // Ignore malformed auth URLs supplied by a remote service.
  }
}

async function withTimeout<T>(operation: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("remote_signer_timeout")), OPERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function acquireSlot() {
  if (activeOperations < MAX_ACTIVE_OPERATIONS) {
    activeOperations += 1;
    return;
  }
  if (waitingOperations.length >= MAX_WAITING_OPERATIONS) {
    throw new Error("remote_signer_queue_full");
  }
  await new Promise<void>(resolve => waitingOperations.push(resolve));
  activeOperations += 1;
}

function releaseSlot() {
  activeOperations = Math.max(0, activeOperations - 1);
  waitingOperations.shift()?.();
}

async function runBounded<T>(operation: () => Promise<T>) {
  await acquireSlot();
  try {
    return await withTimeout(operation());
  } finally {
    releaseSlot();
  }
}

async function createSigner(
  clientSecretHex: string,
  pointer: { pubkey: string; relays: string[]; secret: string | null },
) {
  const module = await import("nostr-tools/nip46");
  const normalizedPointer = {
    pubkey: normalizePubkey(pointer.pubkey, "bunker_pubkey"),
    relays: normalizeRelays(pointer.relays),
    secret: pointer.secret,
  };
  return module.BunkerSigner.fromBunker(
    bytes(clientSecretHex),
    normalizedPointer,
    { onauth: showAuthorization },
  ) as RemoteSignerLike;
}

async function replaceSession(accountPubkey: string, signer: RemoteSignerLike) {
  const account = normalizePubkey(accountPubkey, "account_pubkey");
  const previous = sessions.get(account);
  if (previous) await previous.signer.close().catch(() => undefined);
  const current = { signer, generation: ++generation };
  sessions.set(account, current);
  return current;
}

async function establish(
  clientSecretHex: string,
  pointer: { pubkey: string; relays: string[]; secret: string | null },
) {
  const signer = await createSigner(clientSecretHex, pointer);
  try {
    await runBounded(() => signer.connect());
    const accountPubkey = normalizePubkey(
      await runBounded(() => signer.getPublicKey()),
      "account_pubkey",
    );
    await replaceSession(accountPubkey, signer);
    return { accountPubkey, signer };
  } catch (error) {
    await signer.close().catch(() => undefined);
    throw error;
  }
}

export function nip46FeatureEnabled() {
  return import.meta.env.VITE_ENABLE_NIP46 === "true";
}

export async function connectRemoteSignerFromInput(input: string) {
  if (!nip46FeatureEnabled()) throw new Error("remote_signer_feature_disabled");
  const normalizedInput = input.trim();
  if (!normalizedInput) throw new Error("remote_signer_input_required");
  const module = await import("nostr-tools/nip46");
  const pointer = await module.parseBunkerInput(normalizedInput);
  if (!pointer) throw new Error("invalid_remote_signer_input");
  pointer.relays = normalizeRelays(pointer.relays);
  const clientSecretBytes = crypto.getRandomValues(new Uint8Array(32));
  const clientSecretHex = hex(clientSecretBytes);
  clientSecretBytes.fill(0);
  const { accountPubkey } = await establish(clientSecretHex, pointer);
  const credential: RemoteSignerCredential = {
    accountPubkey,
    bunkerPubkey: normalizePubkey(pointer.pubkey, "bunker_pubkey"),
    relays: pointer.relays,
    clientSecretHex,
  };
  return credential;
}

export async function reconnectRemoteSignerFromCredential(credential: RemoteSignerCredential) {
  if (!nip46FeatureEnabled()) throw new Error("remote_signer_feature_disabled");
  const account = normalizePubkey(credential.accountPubkey, "account_pubkey");
  const { accountPubkey } = await establish(credential.clientSecretHex, {
    pubkey: credential.bunkerPubkey,
    relays: credential.relays,
    secret: null,
  });
  if (accountPubkey !== account) {
    await disconnectRemoteSigner(accountPubkey);
    throw new Error("remote_signer_account_mismatch");
  }
  return true;
}

export function isRemoteSignerConnected(accountPubkey: string) {
  return sessions.has(accountPubkey.toLowerCase());
}

export async function disconnectRemoteSigner(accountPubkey: string) {
  const account = accountPubkey.toLowerCase();
  const session = sessions.get(account);
  sessions.delete(account);
  if (session) await session.signer.close().catch(() => undefined);
}

async function withSession<T>(
  accountPubkey: string,
  operation: (signer: RemoteSignerLike) => Promise<T>,
) {
  const account = normalizePubkey(accountPubkey, "account_pubkey");
  const session = sessions.get(account);
  if (!session) throw new Error("remote_signer_offline");
  const expectedGeneration = session.generation;
  try {
    const result = await runBounded(() => operation(session.signer));
    if (sessions.get(account)?.generation !== expectedGeneration) {
      throw new Error("remote_signer_session_changed");
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "remote_signer_timeout") {
      await disconnectRemoteSigner(account);
    }
    throw error;
  }
}

export function remoteSignEvent(accountPubkey: string, event: EventTemplate) {
  return withSession(accountPubkey, signer => signer.signEvent(event));
}

export function remoteNip44Encrypt(accountPubkey: string, peerPubkey: string, plaintext: string) {
  return withSession(accountPubkey, signer => signer.nip44Encrypt(peerPubkey, plaintext));
}

export function remoteNip44Decrypt(accountPubkey: string, peerPubkey: string, ciphertext: string) {
  return withSession(accountPubkey, signer => signer.nip44Decrypt(peerPubkey, ciphertext));
}

export const NIP46_OPERATION_LIMITS = {
  maxActive: MAX_ACTIVE_OPERATIONS,
  maxWaiting: MAX_WAITING_OPERATIONS,
  timeoutMs: OPERATION_TIMEOUT_MS,
} as const;
