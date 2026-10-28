import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { nip44, utils } from "nostr-tools";
import type { PrivateSpaceRecord, PrivateSpaceShare, SharedTodoContent } from "@/db/dexie";
import { privateSpaceRepository } from "@/repositories/privateSpaceRepository";
import { signedWorkerPost } from "@/services/workerAuth";
import { haineiWorkerBaseUrl } from "@/services/workerUrl";
import { timedJsonFetch } from "@/utils/timedFetch";
import { validTaskDue } from "@/utils/todoPlanning";
import { sameSharedTodoContent } from "@/utils/sharedTodoMerge";

export type SharedTodoKeys = {
  pkHex: string;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
};
type ListEntry = { id: string; owner: string; version: number; wrappedKey: string; members: string[] };
type SyncOptions = {
  isCurrent: () => boolean;
  signal?: AbortSignal;
  /** Whether a list shared by this pubkey may appear (accepted friends). */
  isTrustedOwner: (pubkey: string) => boolean;
  isEditing: () => boolean;
};

export const SHARED_TODO_MAX_MEMBERS = 20;
const SHARED_TODO_MAX_BYTES = 60_000;
const PUBKEY = /^[0-9a-f]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;

function ensureCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error("stale_account_session");
}
async function responseJson(response: Response): Promise<any> {
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(String(result?.error || "shared_todo_http_" + response.status)) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return result;
}
async function post(
  keys: SharedTodoKeys, route: string, payload: Record<string, unknown>,
  isCurrent: () => boolean = () => true, signal?: AbortSignal,
): Promise<any> {
  ensureCurrent(isCurrent);
  const base = haineiWorkerBaseUrl();
  const url = base + "/api/shared-todo/" + route;
  const response = await signedWorkerPost(keys.signEvent.bind(keys), keys.pkHex, {
    action: "hainei_shared_todo",
    url, payload,
    content: "Authorize shared to-do list sync",
    ensureCurrent: () => ensureCurrent(isCurrent),
    challenge: async () => responseJson(await timedJsonFetch(base + "/api/auth/challenge", { method: "POST", signal })),
    send: body => timedJsonFetch(url, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  ensureCurrent(isCurrent);
  return responseJson(response);
}

function contentOf(record: SharedTodoContent): SharedTodoContent {
  return { title: record.title, tasks: record.tasks.map(task => ({ ...task })) };
}
function encryptContent(id: string, key: string, content: SharedTodoContent) {
  const plaintext = JSON.stringify({ schemaVersion: 1, id, list: contentOf(content) });
  if (new TextEncoder().encode(plaintext).byteLength > SHARED_TODO_MAX_BYTES) throw new Error("shared_todo_too_large");
  return nip44.v2.encrypt(plaintext, utils.hexToBytes(key));
}
export function decryptSharedTodo(id: string, key: string, ciphertext: string): SharedTodoContent {
  const data = JSON.parse(nip44.v2.decrypt(ciphertext, utils.hexToBytes(key)));
  const list = data?.list;
  if (data?.schemaVersion !== 1 || data?.id !== id || typeof list?.title !== "string" || list.title.length > 500 ||
      !Array.isArray(list.tasks) || list.tasks.length > 1000 ||
      list.tasks.some((task: any) => !task || typeof task.id !== "string" || !task.id || task.id.length > 200 ||
        typeof task.text !== "string" || task.text.length > 2000 || typeof task.done !== "boolean"))
    throw new Error("invalid_shared_todo_envelope");
  const seen = new Set<string>();
  return {
    title: list.title,
    tasks: list.tasks.filter((task: any) => !seen.has(task.id) && seen.add(task.id)).map((task: any) => ({
      id: task.id, text: task.text, done: task.done, ...(validTaskDue(task.due) ? { due: task.due } : {}),
    })),
  };
}

function validEntries(response: any, account: string): ListEntry[] {
  if (!Array.isArray(response?.items)) throw new Error("invalid_shared_todo_manifest");
  return response.items.map((entry: ListEntry) => {
    if (!entry || typeof entry.id !== "string" || !ID.test(entry.id) || typeof entry.owner !== "string" ||
        !PUBKEY.test(entry.owner) || !Number.isSafeInteger(entry.version) || entry.version < 1 ||
        typeof entry.wrappedKey !== "string" || !Array.isArray(entry.members) ||
        entry.members.some(member => typeof member !== "string" || !PUBKEY.test(member)) ||
        !entry.members.includes(account) || !entry.members.includes(entry.owner))
      throw new Error("invalid_shared_todo_manifest");
    return { ...entry, members: orderedMembers(entry.owner, entry.members) };
  });
}

async function unwrapKey(keys: SharedTodoKeys, entry: ListEntry) {
  // Only the owner can produce a key we can open with the owner's pubkey.
  const key = (await keys.nip44Decrypt(entry.owner, entry.wrappedKey)).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("invalid_shared_todo_key");
  return key;
}

/** Owner first, then the rest in a stable order. */
function orderedMembers(owner: string, members: string[]) {
  return [owner, ...[...new Set(members)].filter(member => member !== owner).sort()];
}
function sameMembers(left: string[], right: string[]) {
  return left.length === right.length && left.every((member, index) => member === right[index]);
}

/**
 * Pull shared lists this account belongs to, then publish local edits with
 * compare-and-swap. Lists that disappeared from the Worker (stopped or we were
 * removed) become private copies. Returns whether local edits remain unsent.
 */
export async function synchronizeSharedTodos(keys: SharedTodoKeys, options: SyncOptions): Promise<{ pending: boolean }> {
  const account = keys.pkHex.toLowerCase();
  const { isCurrent, signal } = options;
  const entries = validEntries(await post(keys, "list", {}, isCurrent, signal), account);
  const remote = new Map(entries.map(entry => [entry.id, entry]));
  const locals = new Map((await privateSpaceRepository.list(account)).map(note => [note.id, note]));
  ensureCurrent(isCurrent);

  const stale: { entry: ListEntry; key: string }[] = [];
  for (const entry of entries) {
    const local = locals.get(entry.id);
    if (local && (local.kind !== "todo" || (local.share ? local.share.owner !== entry.owner : entry.owner !== account))) continue;
    // Anyone can add us on the Worker: a new list appears only from an accepted friend.
    if (!local?.share && entry.owner !== account && !options.isTrustedOwner(entry.owner)) continue;
    if (local?.share && local.share.version >= entry.version) {
      if (!sameMembers(local.share.members, entry.members))
        await privateSpaceRepository.updateShareMembers(account, entry.id, entry.members);
      continue;
    }
    try {
      stale.push({ entry, key: local?.share?.key || await unwrapKey(keys, entry) });
    } catch {
      // A key we cannot open never blocks the other lists.
    }
    ensureCurrent(isCurrent);
  }
  for (let i = 0; i < stale.length; i += 8) {
    await pull(keys, account, stale.slice(i, i + 8), options);
  }

  let pending = false;
  for (const note of await privateSpaceRepository.list(account)) {
    ensureCurrent(isCurrent);
    const share = note.share;
    if (!share || share.version < 1) continue;
    if (!remote.has(note.id)) {
      // Stopped by the owner or we were removed: keep what we had, privately.
      await privateSpaceRepository.detachShare(account, note.id);
      continue;
    }
    if (note.deletedAt) {
      await post(keys, "leave", { id: note.id }, isCurrent, signal);
      await privateSpaceRepository.detachShare(account, note.id);
      continue;
    }
    if (await publish(keys, account, note, options)) pending = true;
  }
  return { pending };
}

async function pull(keys: SharedTodoKeys, account: string, batch: { entry: ListEntry; key: string }[], options: SyncOptions) {
  const response = await post(keys, "get", { ids: batch.map(item => item.entry.id) }, options.isCurrent, options.signal);
  if (!Array.isArray(response?.items)) throw new Error("invalid_shared_todo_response");
  for (const row of response.items as { id: string; version: number; ciphertext: string }[]) {
    const item = batch.find(candidate => candidate.entry.id === row?.id);
    if (!item || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.ciphertext !== "string") continue;
    let content: SharedTodoContent;
    try { content = decryptSharedTodo(row.id, item.key, row.ciphertext); } catch { continue; }
    ensureCurrent(options.isCurrent);
    if (options.isEditing()) throw new Error("private_space_editing");
    await privateSpaceRepository.applyShared(account, row.id, content, {
      owner: item.entry.owner, members: item.entry.members, key: item.key, version: row.version,
    });
  }
}

/** Publish one dirty list; on a version conflict pull, merge and retry. True if still dirty. */
async function publish(keys: SharedTodoKeys, account: string, note: PrivateSpaceRecord, options: SyncOptions) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = attempt ? await privateSpaceRepository.get(account, note.id) : note;
    const share = current?.share;
    if (!current || !share || current.deletedAt) return false;
    if (current.revision === share.syncedRevision) return false;
    const content = contentOf(current);
    if (sameSharedTodoContent(content, share.base)) {
      await privateSpaceRepository.markSharedSynced(account, current.id, current.revision, share.version, content);
      return false;
    }
    let ciphertext: string;
    try { ciphertext = encryptContent(current.id, share.key, content); } catch { return true; }
    try {
      const result = await post(keys, "put", { id: current.id, expectedVersion: share.version, ciphertext },
        options.isCurrent, options.signal);
      if (result?.id !== current.id || result.version !== share.version + 1) throw new Error("invalid_shared_todo_upload_ack");
      await privateSpaceRepository.markSharedSynced(account, current.id, current.revision, result.version, content);
      return false;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) {
        await privateSpaceRepository.detachShare(account, current.id);
        return false;
      }
      if (status !== 409) throw error;
      if (options.isEditing()) throw new Error("private_space_editing");
      const entry: ListEntry = {
        id: current.id, owner: share.owner, version: share.version + 1, wrappedKey: "", members: share.members,
      };
      await pull(keys, account, [{ entry, key: share.key }], options);
    }
  }
  return true;
}

/** Share a saved to-do list with friends. The Worker creates it before the row is marked shared. */
export async function shareTodoList(keys: SharedTodoKeys, id: string, friends: string[]) {
  const account = keys.pkHex.toLowerCase();
  const note = await privateSpaceRepository.get(account, id);
  if (!note || note.kind !== "todo" || note.share || note.deletedAt) throw new Error("private_space_share_unavailable");
  const invited = [...new Set(friends.map(friend => friend.toLowerCase()))].filter(friend => friend !== account);
  if (!invited.length || invited.some(friend => !PUBKEY.test(friend))) throw new Error("invalid_shared_todo_members");
  if (invited.length + 1 > SHARED_TODO_MAX_MEMBERS) throw new Error("shared_todo_member_limit");
  const key = utils.bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const content = contentOf(note);
  const ciphertext = encryptContent(id, key, content);
  const members = orderedMembers(account, invited);
  const grants = await Promise.all(members.map(async pubkey => ({ pubkey, wrappedKey: await keys.nip44Encrypt(pubkey, key) })));
  const result = await post(keys, "put", { id, expectedVersion: 0, ciphertext, members: grants });
  if (result?.id !== id || result.version !== 1) throw new Error("invalid_shared_todo_upload_ack");
  const share: PrivateSpaceShare = { owner: account, members, key, version: 1, syncedRevision: note.revision, base: content };
  return privateSpaceRepository.attachShare(account, id, share);
}

/** Owner adds or removes members. Removed members keep only what they already saw. */
export async function updateTodoMembers(keys: SharedTodoKeys, id: string, add: string[], remove: string[]) {
  const account = keys.pkHex.toLowerCase();
  const note = await privateSpaceRepository.get(account, id);
  const share = note?.share;
  if (!share || share.owner !== account) throw new Error("private_space_share_unavailable");
  const invited = [...new Set(add.map(friend => friend.toLowerCase()))]
    .filter(friend => PUBKEY.test(friend) && !share.members.includes(friend));
  const grants = await Promise.all(invited.map(async pubkey => ({ pubkey, wrappedKey: await keys.nip44Encrypt(pubkey, share.key) })));
  const result = await post(keys, "members", { id, add: grants, remove });
  if (!Array.isArray(result?.members)) throw new Error("invalid_shared_todo_response");
  const members = orderedMembers(account, result.members as string[]);
  return privateSpaceRepository.updateShareMembers(account, id, members);
}

/** A member leaves (the list moves to 最近删除); the owner stops sharing and keeps a private copy. */
export async function leaveTodoList(keys: SharedTodoKeys, id: string) {
  const account = keys.pkHex.toLowerCase();
  const note = await privateSpaceRepository.get(account, id);
  if (!note?.share) throw new Error("private_space_share_unavailable");
  await post(keys, "leave", { id });
  return privateSpaceRepository.detachShare(account, id, { trash: note.share.owner !== account });
}
