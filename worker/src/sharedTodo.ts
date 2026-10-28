import { HttpError, type Env } from "./types";

const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const PUBKEY = /^[0-9a-f]{64}$/;
const MAX_CIPHERTEXT_BYTES = 256 * 1024;
const MAX_WRAPPED_KEY_BYTES = 1024;
const FETCH_LIMIT = 8;
/** Owner included. */
export const SHARED_TODO_MAX_MEMBERS = 20;
/** Per account, owned or joined; the list endpoint returns them in one page. */
export const SHARED_TODO_MAX_LISTS = 200;

export class SharedTodoConflict extends HttpError {
  constructor(public currentVersion: number) { super(409, "shared_todo_conflict"); }
}
function listId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new HttpError(400, "invalid_shared_todo_id");
  return value;
}
function pubkey(value: unknown): string {
  if (typeof value !== "string" || !PUBKEY.test(value)) throw new HttpError(400, "invalid_shared_todo_member");
  return value;
}
function encrypted(value: unknown): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > MAX_CIPHERTEXT_BYTES)
    throw new HttpError(413, "invalid_shared_todo_ciphertext");
  return value;
}
function memberGrants(value: unknown, maximum: number): { pubkey: string; wrappedKey: string }[] {
  if (!Array.isArray(value) || value.length > maximum) throw new HttpError(400, "invalid_shared_todo_members");
  const seen = new Set<string>();
  return value.map(raw => {
    const grant = raw as { pubkey?: unknown; wrappedKey?: unknown } | null;
    const member = pubkey(grant?.pubkey);
    const wrappedKey = grant?.wrappedKey;
    if (seen.has(member) || typeof wrappedKey !== "string" || !wrappedKey ||
        new TextEncoder().encode(wrappedKey).byteLength > MAX_WRAPPED_KEY_BYTES)
      throw new HttpError(400, "invalid_shared_todo_members");
    seen.add(member);
    return { pubkey: member, wrappedKey };
  });
}

async function ensureListCapacity(env: Env, members: string[]) {
  if (!members.length) return;
  const marks = members.map(() => "?").join(",");
  const counts = await env.DB.prepare(
    "SELECT member_pubkey, COUNT(*) AS lists FROM hainei_shared_todo_members WHERE member_pubkey IN (" + marks + ") GROUP BY member_pubkey"
  ).bind(...members).all<{ member_pubkey: string; lists: number }>();
  if (counts.results.some(row => Number(row.lists) >= SHARED_TODO_MAX_LISTS))
    throw new HttpError(409, "shared_todo_member_limit");
}

async function listOwner(env: Env, id: string) {
  return env.DB.prepare(
    "SELECT owner_pubkey, version FROM hainei_shared_todos WHERE list_id = ?"
  ).bind(id).first<{ owner_pubkey: string; version: number }>();
}

/** Lists this account belongs to, with its wrapped key and the member roster. No contents. */
export async function listSharedTodos(env: Env, account: string) {
  const lists = await env.DB.prepare(
    "SELECT t.list_id, t.owner_pubkey, t.version, m.wrapped_key FROM hainei_shared_todo_members m JOIN hainei_shared_todos t ON t.list_id = m.list_id WHERE m.member_pubkey = ? ORDER BY t.list_id ASC LIMIT ?"
  ).bind(account, SHARED_TODO_MAX_LISTS).all<{ list_id: string; owner_pubkey: string; version: number; wrapped_key: string }>();
  const roster = await env.DB.prepare(
    "SELECT list_id, member_pubkey FROM hainei_shared_todo_members WHERE list_id IN (SELECT list_id FROM hainei_shared_todo_members WHERE member_pubkey = ?) ORDER BY added_at ASC, member_pubkey ASC"
  ).bind(account).all<{ list_id: string; member_pubkey: string }>();
  const members = new Map<string, string[]>();
  for (const row of roster.results) {
    const entry = members.get(row.list_id) || [];
    entry.push(row.member_pubkey);
    members.set(row.list_id, entry);
  }
  return { items: lists.results.map(row => ({
    id: row.list_id, owner: row.owner_pubkey, version: Number(row.version),
    wrappedKey: row.wrapped_key, members: members.get(row.list_id) || [],
  })) };
}

/** Ciphertext only for lists the signed-in account is a member of. */
export async function getSharedTodos(env: Env, account: string, idsValue: unknown) {
  if (!Array.isArray(idsValue) || !idsValue.length || idsValue.length > FETCH_LIMIT)
    throw new HttpError(400, "invalid_shared_todo_ids");
  const ids = [...new Set(idsValue.map(listId))];
  const marks = ids.map(() => "?").join(",");
  const response = await env.DB.prepare(
    "SELECT t.list_id, t.version, t.ciphertext FROM hainei_shared_todos t JOIN hainei_shared_todo_members m ON m.list_id = t.list_id AND m.member_pubkey = ? WHERE t.list_id IN (" + marks + ")"
  ).bind(account, ...ids).all<{ list_id: string; version: number; ciphertext: string }>();
  return { items: response.results.map(row => ({ id: row.list_id, version: Number(row.version), ciphertext: row.ciphertext })) };
}

/**
 * expectedVersion 0 creates the list with its first members (owner included) in
 * one D1 batch. Later writes by any member are compare-and-swap on the version.
 */
export async function putSharedTodo(env: Env, account: string, payload: Record<string, unknown>, now = Date.now()) {
  const id = listId(payload.id);
  const ciphertext = encrypted(payload.ciphertext);
  const expectedVersion = Number(payload.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    throw new HttpError(400, "invalid_shared_todo_expected_version");
  if (expectedVersion === 0) {
    const grants = memberGrants(payload.members, SHARED_TODO_MAX_MEMBERS);
    if (!grants.some(grant => grant.pubkey === account) || grants.length < 2)
      throw new HttpError(400, "invalid_shared_todo_members");
    await ensureListCapacity(env, grants.map(grant => grant.pubkey));
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO hainei_shared_todos (list_id, owner_pubkey, version, ciphertext, updated_at) VALUES (?, ?, 1, ?, ?)"
        ).bind(id, account, ciphertext, now),
        ...grants.map(grant => env.DB.prepare(
          "INSERT INTO hainei_shared_todo_members (list_id, member_pubkey, wrapped_key, added_at) VALUES (?, ?, ?, ?)"
        ).bind(id, grant.pubkey, grant.wrappedKey, now)),
      ]);
      return { id, version: 1 };
    } catch (error) {
      const existing = await listOwner(env, id);
      if (!existing) throw error;
      throw new SharedTodoConflict(existing.owner_pubkey === account ? Number(existing.version) : 0);
    }
  }
  const updated = await env.DB.prepare(
    "UPDATE hainei_shared_todos SET version = version + 1, ciphertext = ?, updated_at = ? WHERE list_id = ? AND version = ? AND EXISTS (SELECT 1 FROM hainei_shared_todo_members WHERE list_id = ? AND member_pubkey = ?)"
  ).bind(ciphertext, now, id, expectedVersion, id, account).run();
  if (Number(updated.meta?.changes || 0) === 1) return { id, version: expectedVersion + 1 };
  const member = await env.DB.prepare(
    "SELECT t.version FROM hainei_shared_todos t JOIN hainei_shared_todo_members m ON m.list_id = t.list_id AND m.member_pubkey = ? WHERE t.list_id = ?"
  ).bind(account, id).first<{ version: number }>();
  if (!member) throw new HttpError(404, "shared_todo_not_found");
  throw new SharedTodoConflict(Number(member.version));
}

/** Only the owner adds or removes members; the owner cannot remove themselves. */
export async function updateSharedTodoMembers(env: Env, account: string, payload: Record<string, unknown>, now = Date.now()) {
  const id = listId(payload.id);
  const add = memberGrants(payload.add ?? [], SHARED_TODO_MAX_MEMBERS);
  if (!Array.isArray(payload.remove ?? []) || ((payload.remove ?? []) as unknown[]).length > SHARED_TODO_MAX_MEMBERS)
    throw new HttpError(400, "invalid_shared_todo_members");
  const remove = [...new Set(((payload.remove ?? []) as unknown[]).map(pubkey))];
  if (remove.includes(account) || add.some(grant => grant.pubkey === account || remove.includes(grant.pubkey)))
    throw new HttpError(400, "invalid_shared_todo_members");
  const existing = await listOwner(env, id);
  if (!existing || existing.owner_pubkey !== account) throw new HttpError(404, "shared_todo_not_found");
  const current = await env.DB.prepare(
    "SELECT member_pubkey FROM hainei_shared_todo_members WHERE list_id = ?"
  ).bind(id).all<{ member_pubkey: string }>();
  const members = new Set(current.results.map(row => row.member_pubkey));
  const added = add.filter(grant => !members.has(grant.pubkey));
  for (const member of remove) members.delete(member);
  for (const grant of added) members.add(grant.pubkey);
  if (members.size > SHARED_TODO_MAX_MEMBERS) throw new HttpError(409, "shared_todo_member_limit");
  await ensureListCapacity(env, added.map(grant => grant.pubkey));
  const statements = [
    ...remove.map(member => env.DB.prepare(
      "DELETE FROM hainei_shared_todo_members WHERE list_id = ? AND member_pubkey = ?"
    ).bind(id, member)),
    ...added.map(grant => env.DB.prepare(
      "INSERT OR IGNORE INTO hainei_shared_todo_members (list_id, member_pubkey, wrapped_key, added_at) VALUES (?, ?, ?, ?)"
    ).bind(id, grant.pubkey, grant.wrappedKey, now)),
  ];
  if (statements.length) await env.DB.batch(statements);
  return { id, members: [...members] };
}

/** A member leaves; when the owner leaves, the list is deleted for everyone. */
export async function leaveSharedTodo(env: Env, account: string, idValue: unknown) {
  const id = listId(idValue);
  const existing = await listOwner(env, id);
  if (!existing) return { id, deleted: true };
  if (existing.owner_pubkey === account) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM hainei_shared_todo_members WHERE list_id = ?").bind(id),
      env.DB.prepare("DELETE FROM hainei_shared_todos WHERE list_id = ?").bind(id),
    ]);
    return { id, deleted: true };
  }
  await env.DB.prepare(
    "DELETE FROM hainei_shared_todo_members WHERE list_id = ? AND member_pubkey = ?"
  ).bind(id, account).run();
  return { id, deleted: false };
}
