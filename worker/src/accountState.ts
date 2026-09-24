import { HttpError, type Env } from "./types";

export const ACCOUNT_STATE_NAMESPACES = [
  "friendships", "friend_metadata", "own_profile", "settings", "bookmarks",
  "feed_preferences", "read_state", "notification_state",
] as const;
export type AccountStateNamespace = typeof ACCOUNT_STATE_NAMESPACES[number];

const allowed = new Set<string>(ACCOUNT_STATE_NAMESPACES);
const MAX_CIPHERTEXT_BYTES = 256 * 1024;
const MAX_NAMESPACES_PER_GET = ACCOUNT_STATE_NAMESPACES.length;

export class AccountStateConflict extends HttpError {
  constructor(public currentVersion: number) { super(409, "account_state_conflict"); }
}

function namespace(value: unknown): AccountStateNamespace {
  if (typeof value !== "string" || !allowed.has(value)) throw new HttpError(400, "invalid_account_state_namespace");
  return value as AccountStateNamespace;
}

function ciphertext(value: unknown) {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > MAX_CIPHERTEXT_BYTES) {
    throw new HttpError(413, "invalid_account_state_ciphertext");
  }
  return value;
}

export async function getAccountState(env: Env, accountPubkey: string, namespaceValues: unknown) {
  if (!Array.isArray(namespaceValues) || namespaceValues.length > MAX_NAMESPACES_PER_GET) {
    throw new HttpError(400, "invalid_account_state_namespaces");
  }
  const namespaces = [...new Set(namespaceValues.map(namespace))];
  if (!namespaces.length) return { snapshots: [] };
  const placeholders = namespaces.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT namespace, version, ciphertext, updated_at, device_id
    FROM hainei_account_snapshots
    WHERE account_pubkey = ? AND namespace IN (${placeholders})
  `).bind(accountPubkey, ...namespaces).all<{
    namespace: AccountStateNamespace; version: number; ciphertext: string; updated_at: number; device_id: string | null;
  }>();
  return { snapshots: rows.results.map(row => ({
    namespace: row.namespace,
    version: Number(row.version),
    ciphertext: row.ciphertext,
    updatedAt: Number(row.updated_at),
    deviceId: row.device_id || undefined,
  })) };
}

export async function putAccountState(env: Env, accountPubkey: string, payload: Record<string, unknown>, now = Date.now()) {
  const stateNamespace = namespace(payload.namespace);
  const encrypted = ciphertext(payload.ciphertext);
  const expectedVersion = Number(payload.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new HttpError(400, "invalid_expected_version");
  const deviceId = typeof payload.deviceId === "string" ? payload.deviceId.trim().slice(0, 128) || null : null;

  if (expectedVersion === 0) {
    try {
      const inserted = await env.DB.prepare(`
        INSERT INTO hainei_account_snapshots
          (account_pubkey, namespace, version, ciphertext, updated_at, device_id)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(account_pubkey, namespace) DO NOTHING
      `).bind(accountPubkey, stateNamespace, encrypted, now, deviceId).run();
      if (Number(inserted.meta?.changes || 0) === 1) return { namespace: stateNamespace, version: 1, updatedAt: now };
    } catch {
      // A concurrent creator is reported as the same optimistic conflict below.
    }
  } else {
    const updated = await env.DB.prepare(`
      UPDATE hainei_account_snapshots
      SET version = version + 1, ciphertext = ?, updated_at = ?, device_id = ?
      WHERE account_pubkey = ? AND namespace = ? AND version = ?
    `).bind(encrypted, now, deviceId, accountPubkey, stateNamespace, expectedVersion).run();
    if (Number(updated.meta?.changes || 0) === 1) {
      return { namespace: stateNamespace, version: expectedVersion + 1, updatedAt: now };
    }
  }

  const current = await env.DB.prepare(`
    SELECT version FROM hainei_account_snapshots WHERE account_pubkey = ? AND namespace = ?
  `).bind(accountPubkey, stateNamespace).first<{ version: number }>();
  throw new AccountStateConflict(Number(current?.version || 0));
}
