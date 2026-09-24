import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountStateConflict, getAccountState, putAccountState } from "../worker/src/accountState";

type Row = { account_pubkey: string; namespace: string; version: number; ciphertext: string; updated_at: number; device_id: string | null };

class SnapshotD1 {
  rows = new Map<string, Row>();

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return this.bound(normalized, []);
  }

  private bound(sql: string, values: unknown[]): any {
    return {
      bind: (...next: unknown[]) => this.bound(sql, next),
      all: async () => {
        const account = String(values[0]);
        const namespaces = new Set(values.slice(1).map(String));
        return { results: [...this.rows.values()].filter(row => row.account_pubkey === account && namespaces.has(row.namespace)) };
      },
      first: async () => {
        const row = this.rows.get(`${values[0]}|${values[1]}`);
        return row ? { version: row.version } : null;
      },
      run: async () => {
        if (sql.startsWith("INSERT INTO hainei_account_snapshots")) {
          const [account, namespace, ciphertext, updatedAt, deviceId] = values;
          const key = `${account}|${namespace}`;
          if (this.rows.has(key)) return { meta: { changes: 0 } };
          this.rows.set(key, { account_pubkey: String(account), namespace: String(namespace), version: 1, ciphertext: String(ciphertext), updated_at: Number(updatedAt), device_id: deviceId ? String(deviceId) : null });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE hainei_account_snapshots")) {
          const [ciphertext, updatedAt, deviceId, account, namespace, expected] = values;
          const key = `${account}|${namespace}`;
          const row = this.rows.get(key);
          if (!row || row.version !== Number(expected)) return { meta: { changes: 0 } };
          Object.assign(row, { ciphertext: String(ciphertext), updated_at: Number(updatedAt), device_id: deviceId ? String(deviceId) : null, version: row.version + 1 });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}

function env(database: SnapshotD1) { return { DB: database } as any; }

describe("Worker encrypted account snapshots", () => {
  it("stores only opaque ciphertext and isolates rows by authenticated pubkey", async () => {
    const database = new SnapshotD1();
    await putAccountState(env(database), "a".repeat(64), { namespace: "own_profile", ciphertext: "nip44-ciphertext", expectedVersion: 0, deviceId: "iphone" }, 10);
    const own = await getAccountState(env(database), "a".repeat(64), ["own_profile"]);
    const other = await getAccountState(env(database), "b".repeat(64), ["own_profile"]);
    expect(own.snapshots).toEqual([{ namespace: "own_profile", version: 1, ciphertext: "nip44-ciphertext", updatedAt: 10, deviceId: "iphone" }]);
    expect(other.snapshots).toEqual([]);
    expect(JSON.stringify([...database.rows.values()])).not.toContain("nickname");
  });

  it("enforces optimistic versions and rejects unknown namespaces", async () => {
    const database = new SnapshotD1();
    const account = "a".repeat(64);
    await putAccountState(env(database), account, { namespace: "bookmarks", ciphertext: "one", expectedVersion: 0 }, 10);
    await expect(putAccountState(env(database), account, { namespace: "bookmarks", ciphertext: "stale", expectedVersion: 0 }, 11))
      .rejects.toBeInstanceOf(AccountStateConflict);
    await expect(putAccountState(env(database), account, { namespace: "messages", ciphertext: "bad", expectedVersion: 0 }, 11))
      .rejects.toMatchObject({ status: 400 });
    await expect(putAccountState(env(database), account, { namespace: "bookmarks", ciphertext: "two", expectedVersion: 1 }, 12))
      .resolves.toMatchObject({ version: 2 });
  });

  it("defines the required composite-key D1 table", () => {
    const sql = readFileSync(join(process.cwd(), "worker/migrations/0003_account_snapshots.sql"), "utf8");
    expect(sql).toContain("hainei_account_snapshots");
    expect(sql).toContain("PRIMARY KEY (account_pubkey, namespace)");
    expect(sql).not.toMatch(/plaintext|message_body|post_body/i);
  });
});
