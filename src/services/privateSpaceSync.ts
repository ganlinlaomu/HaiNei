import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { privateSpaceRepository } from "@/repositories/privateSpaceRepository";
import type { PrivateSpaceRecord } from "@/db/dexie";
import { signWorkerRequest } from "@/services/workerAuth";
import { haineiWorkerBaseUrl } from "@/services/workerUrl";
import { timedJsonFetch } from "@/utils/timedFetch";

type Keys = {
  pkHex: string;
  sessionGeneration?: number;
  isUnlocked: boolean;
  supportsNip44: boolean;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
};
export type PrivateSpaceSyncStatus = "local" | "syncing" | "synced" | "offline" | "error" | "unavailable";
export type PrivateSpaceSyncState = { account: string; status: PrivateSpaceSyncStatus; error?: string; conflicts: number };
type Listener = (state: PrivateSpaceSyncState) => void;
type Manifest = { id: string; version: number };
type CloudRow = Manifest & { ciphertext: string };

const listeners = new Set<Listener>();
const activeEditors = new Set<string>();
export function setPrivateSpaceEditing(account: string, editing: boolean) {
  const owner = account.toLowerCase();
  if (editing) activeEditors.add(owner);
  else activeEditors.delete(owner);
}
const jobs = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const retries = new Map<string, number>();
const status = new Map<string, PrivateSpaceSyncState>();
const RETRIES = [1_000, 5_000, 15_000, 60_000, 300_000];

function publish(account: string, next: PrivateSpaceSyncStatus, error?: string, conflicts = 0) {
  const state: PrivateSpaceSyncState = { account, status: next, error, conflicts };
  status.set(account, state);
  for (const listener of listeners) listener(state);
}
export function subscribePrivateSpaceSync(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getPrivateSpaceSyncState(account: string) {
  return status.get(account) || { account, status: "local" as const, conflicts: 0 };
}
function active(keys: Keys, account: string, generation: number | undefined) {
  return keys.pkHex.toLowerCase() === account && keys.sessionGeneration === generation
    && keys.isUnlocked && keys.supportsNip44;
}
function ensureCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error("stale_account_session");
}

async function post(
  keys: Keys, path: string, payload: Record<string, unknown>, isCurrent: () => boolean,
): Promise<any> {
  ensureCurrent(isCurrent);
  const base = haineiWorkerBaseUrl();
  const authResponse = await timedJsonFetch(base + "/api/auth/challenge", { method: "POST" });
  const challenge = await responseJson(authResponse);
  ensureCurrent(isCurrent);
  const url = base + path;
  const event = await signWorkerRequest(keys.signEvent.bind(keys), keys.pkHex, {
    action: "hainei_private_space",
    challenge: String(challenge.challenge || ""),
    expiresAt: Number(challenge.expiresAt || 0),
    url, method: "POST", payload,
    content: "Authorize encrypted private notes sync",
  });
  ensureCurrent(isCurrent);
  const response = await timedJsonFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, event, challenge: challenge.challenge }),
  });
  ensureCurrent(isCurrent);
  return responseJson(response);
}
async function responseJson(response: Response): Promise<any> {
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(String(result?.error || "private_space_http_" + response.status)) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return result;
}

function envelope(note: PrivateSpaceRecord): string {
  // Local CAS metadata is never uploaded. No plaintext title or task tags are visible to D1.
  const { accountPubkey, id, kind, title, body, tasks, pinned, archivedAt, deletedAt, createdAt, updatedAt, revision } = note;
  return JSON.stringify({ schemaVersion: 1, id, note: {
    accountPubkey, id, kind, title, body, tasks, pinned, archivedAt, deletedAt,
    createdAt, updatedAt, revision,
  } });
}
function decode(account: string, id: string, plaintext: string): PrivateSpaceRecord {
  const data = JSON.parse(plaintext);
  const row = data?.note as PrivateSpaceRecord | undefined;
  if (data?.schemaVersion !== 1 || data?.id !== id || row?.id !== id ||
      row.accountPubkey !== account || (row.kind !== "note" && row.kind !== "todo") ||
      typeof row.title !== "string" || typeof row.body !== "string" ||
      row.title.length > 500 || row.body.length > 100_000 || !Array.isArray(row.tasks) ||
      row.tasks.length > 1000 || typeof row.pinned !== "boolean" ||
      !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.updatedAt) ||
      !Number.isSafeInteger(row.revision) || row.revision < 1 ||
      row.tasks.some(task => !task || typeof task.id !== "string" || typeof task.text !== "string" ||
        task.text.length > 2000 || typeof task.done !== "boolean")) {
    throw new Error("invalid_private_space_envelope");
  }
  // Explicitly discard untrusted synchronization fields even if injected into ciphertext.
  return {
    accountPubkey: account, id, kind: row.kind, title: row.title, body: row.body,
    tasks: row.tasks.map(task => ({ id: task.id, text: task.text, done: task.done })),
    pinned: row.pinned, createdAt: row.createdAt, updatedAt: row.updatedAt,
    revision: row.revision, archivedAt: row.archivedAt, deletedAt: row.deletedAt,
  };
}

async function manifest(keys: Keys, isCurrent: () => boolean) {
  const all = new Map<string, number>();
  let after: string | undefined;
  for (let pages = 0; pages < 1000; pages++) {
    const response = await post(keys, "/api/private-space/list",
      { ...(after ? { after } : {}), limit: 60 }, isCurrent);
    if (!Array.isArray(response.items) || response.items.length > 60) throw new Error("invalid_private_space_manifest");
    for (const entry of response.items as Manifest[]) {
      if (typeof entry.id !== "string" || !Number.isSafeInteger(entry.version) || entry.version < 1)
        throw new Error("invalid_private_space_manifest");
      all.set(entry.id, entry.version);
    }
    if (response.nextCursor == null) return all;
    if (typeof response.nextCursor !== "string" || response.nextCursor === after ||
        !response.items.some((item: Manifest) => item.id === response.nextCursor))
      throw new Error("invalid_private_space_cursor");
    after = response.nextCursor;
  }
  throw new Error("private_space_page_limit");
}

async function synchronize(keys: Keys, isCurrent: () => boolean): Promise<number> {
  const account = keys.pkHex.toLowerCase();
  if (activeEditors.has(account)) throw new Error("private_space_editing");
  const remoteVersions = await manifest(keys, isCurrent);
  ensureCurrent(isCurrent);
  const locally = new Map((await privateSpaceRepository.list(account)).map(note => [note.id, note]));
  let conflicts = 0;
  const needsRemote = [...remoteVersions].filter(([id, version]) =>
    version > Number(locally.get(id)?.cloudVersion || 0)).map(([id]) => id);

  for (let i = 0; i < needsRemote.length; i += 8) {
    const ids = needsRemote.slice(i, i + 8);
    const response = await post(keys, "/api/private-space/get", { ids }, isCurrent);
    if (!Array.isArray(response.items) || response.items.length > ids.length) throw new Error("invalid_private_space_response");
    for (const row of response.items as CloudRow[]) {
      if (!ids.includes(row.id) || row.version !== remoteVersions.get(row.id) || typeof row.ciphertext !== "string")
        throw new Error("invalid_private_space_response");
      const plaintext = await keys.nip44Decrypt(account, row.ciphertext);
      ensureCurrent(isCurrent);
      if (activeEditors.has(account)) throw new Error("private_space_editing");
      const record = decode(account, row.id, plaintext);
      const result = await privateSpaceRepository.applyRemote(account, record, row.version);
      if (result.conflicted) conflicts++;
    }
    ensureCurrent(isCurrent);
  }

  // The server is authoritative about which IDs exist, but not about newer unsynced local edits.
  if (activeEditors.has(account)) throw new Error("private_space_editing");
  const current = await privateSpaceRepository.list(account);
  for (const note of current) {
    ensureCurrent(isCurrent);
    if (note.revision === Number(note.syncedRevision || 0) &&
        remoteVersions.get(note.id) === Number(note.cloudVersion || 0)) continue;
    if (remoteVersions.has(note.id) &&
        remoteVersions.get(note.id)! > Number(note.cloudVersion || 0)) {
      throw new Error("private_space_remote_changed");
    }
    const expectedVersion = remoteVersions.get(note.id) || 0;
    const ciphertext = await keys.nip44Encrypt(account, envelope(note));
    ensureCurrent(isCurrent);
    const result = await post(keys, "/api/private-space/put",
      { id: note.id, expectedVersion, ciphertext }, isCurrent);
    if (result.id !== note.id || result.version !== expectedVersion + 1)
      throw new Error("invalid_private_space_upload_ack");
    await privateSpaceRepository.markSynced(account, note.id, note.revision, result.version);
  }
  return conflicts;
}
export async function syncPrivateSpace(keys: Keys): Promise<void> {
  const account = keys.pkHex.toLowerCase();
  const generation = keys.sessionGeneration;
  if (!account || !keys.isUnlocked) return;
  if (!keys.supportsNip44) { publish(account, "unavailable", "当前登录方式无法使用 NIP-44 加密同步"); return; }
  const previous = jobs.get(account);
  if (previous) return previous;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    publish(account, "offline", "设备当前离线，内容仍已保存在本机");
    planRetry(keys, account, generation);
    return;
  }
  const isCurrent = () => active(keys, account, generation);
  publish(account, "syncing");
  const work = (async () => {
    try {
      const conflicts = await synchronize(keys, isCurrent);
      if (!isCurrent()) return;
      retries.delete(account);
      const pending = (await privateSpaceRepository.list(account))
        .some(note => note.revision !== Number(note.syncedRevision || 0));
      if (!isCurrent()) return;
      publish(account, pending ? "local" : "synced", undefined, conflicts);
      if (pending) schedulePrivateSpaceSync(keys, 1_000);
      // Other mounted views may refresh, but must not overwrite an open editor.
      if (typeof window !== "undefined" && typeof CustomEvent !== "undefined")
        window.dispatchEvent(new CustomEvent("hainei-private-space-synced", { detail: { account } }));
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : "private_space_sync_error";
      if (message === "private_space_editing") {
        publish(account, "local");
        return;
      }
      publish(account, "error", message);
      planRetry(keys, account, generation);
    }
  })();
  jobs.set(account, work);
  try { await work; }
  finally { if (jobs.get(account) === work) jobs.delete(account); }
}
function planRetry(keys: Keys, account: string, generation: number | undefined) {
  if (typeof window === "undefined" || !active(keys, account, generation)) return;
  const attempt = Math.min(retries.get(account) || 0, RETRIES.length - 1);
  retries.set(account, attempt + 1);
  schedulePrivateSpaceSync(keys, RETRIES[attempt]);
}
export function schedulePrivateSpaceSync(keys: Keys, delayMs = 900) {
  const account = keys.pkHex.toLowerCase();
  const generation = keys.sessionGeneration;
  if (!account || !keys.isUnlocked || typeof window === "undefined") return;
  const existing = timers.get(account);
  if (existing) clearTimeout(existing);
  timers.set(account, setTimeout(() => {
    timers.delete(account);
    if (active(keys, account, generation)) void syncPrivateSpace(keys);
  }, delayMs));
}
export function notePrivateSpaceMutation(keys: Keys) {
  if (keys.pkHex) {
    publish(keys.pkHex.toLowerCase(), "local");
    schedulePrivateSpaceSync(keys, 1600);
  }
}
export function cancelPrivateSpaceSync(account: string) {
  const timer = timers.get(account);
  if (timer) clearTimeout(timer);
  timers.delete(account);
  retries.delete(account);
  activeEditors.delete(account);
}
