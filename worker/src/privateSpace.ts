import { HttpError, type Env } from "./types";

const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_CIPHERTEXT_BYTES = 256 * 1024;
const PAGE_LIMIT = 100;
const FETCH_LIMIT = 8;

export class PrivateSpaceConflict extends HttpError {
  constructor(public currentVersion: number) { super(409, "private_space_conflict"); }
}
function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new HttpError(400, "invalid_private_space_id");
  return value;
}
function encrypted(value: unknown): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > MAX_CIPHERTEXT_BYTES)
    throw new HttpError(413, "invalid_private_space_ciphertext");
  return value;
}

/** Account-isolated, cursor-paginated version manifest; never exposes note contents. */
export async function listPrivateSpace(env: Env, account: string, afterValue: unknown, limitValue?: unknown) {
  const after = afterValue == null || afterValue === "" ? "" : id(afterValue);
  const limit = limitValue == null ? 60 : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new HttpError(400, "invalid_private_space_limit");
  const response = await env.DB.prepare(
    "SELECT note_id, version FROM hainei_private_space_notes WHERE account_pubkey = ? AND note_id > ? ORDER BY note_id ASC LIMIT ?"
  ).bind(account, after, limit + 1).all<{ note_id: string; version: number }>();
  const hasMore = response.results.length > limit;
  const page = response.results.slice(0, limit).map(row => ({ id: row.note_id, version: Number(row.version) }));
  return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
}

/** Only signed-in owner can access ciphertext, and IDs are bounded. */
export async function getPrivateSpace(env: Env, account: string, idsValue: unknown) {
  if (!Array.isArray(idsValue) || !idsValue.length || idsValue.length > FETCH_LIMIT)
    throw new HttpError(400, "invalid_private_space_ids");
  const ids = [...new Set(idsValue.map(id))];
  const marks = ids.map(() => "?").join(",");
  const response = await env.DB.prepare(
    "SELECT note_id, version, ciphertext FROM hainei_private_space_notes WHERE account_pubkey = ? AND note_id IN (" + marks + ")"
  ).bind(account, ...ids).all<{ note_id: string; version: number; ciphertext: string }>();
  return { items: response.results.map(row => ({ id: row.note_id, version: Number(row.version), ciphertext: row.ciphertext })) };
}

/** Optimistic compare-and-swap on each note ID prevents overwriting remote revisions. */
export async function putPrivateSpace(env: Env, account: string, payload: Record<string, unknown>, now = Date.now()) {
  const noteId = id(payload.id);
  const ciphertext = encrypted(payload.ciphertext);
  const expectedVersion = Number(payload.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    throw new HttpError(400, "invalid_private_space_expected_version");
  if (expectedVersion === 0) {
    const created = await env.DB.prepare(
      "INSERT INTO hainei_private_space_notes (account_pubkey, note_id, version, ciphertext, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(account_pubkey, note_id) DO NOTHING"
    ).bind(account, noteId, ciphertext, now).run();
    if (Number(created.meta?.changes || 0) === 1) return { id: noteId, version: 1 };
  } else {
    const updated = await env.DB.prepare(
      "UPDATE hainei_private_space_notes SET version = version + 1, ciphertext = ?, updated_at = ? WHERE account_pubkey = ? AND note_id = ? AND version = ?"
    ).bind(ciphertext, now, account, noteId, expectedVersion).run();
    if (Number(updated.meta?.changes || 0) === 1) return { id: noteId, version: expectedVersion + 1 };
  }
  const existing = await env.DB.prepare(
    "SELECT version FROM hainei_private_space_notes WHERE account_pubkey = ? AND note_id = ?"
  ).bind(account, noteId).first<{ version: number }>();
  throw new PrivateSpaceConflict(Number(existing?.version || 0));
}
