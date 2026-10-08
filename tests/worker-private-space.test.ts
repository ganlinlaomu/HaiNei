import { describe, expect, it } from "vitest";
import { getPrivateSpace, listPrivateSpace, putPrivateSpace, PrivateSpaceConflict } from "../worker/src/privateSpace";

type Row = { account_pubkey: string; note_id: string; version: number; ciphertext: string; updated_at: number };

class NoteD1 {
  rows = new Map<string, Row>();
  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return this.bound(normalized, []);
  }
  private bound(sql: string, values: unknown[]): any {
    const self = this;
    return {
      bind: (...next: unknown[]) => self.bound(sql, next),
      all: async () => {
        if (sql.includes("note_id IN")) {
          const ids = new Set(values.slice(1).map(String));
          return { results: [...self.rows.values()].filter(row =>
            row.account_pubkey === values[0] && ids.has(row.note_id)) };
        }
        const account = String(values[0]), after = String(values[1]), limit = Number(values[2]);
        return { results: [...self.rows.values()].filter(row =>
          row.account_pubkey === account && row.note_id > after)
            .sort((a, b) => a.note_id.localeCompare(b.note_id)).slice(0, limit) };
      },
      first: async () => {
        const row = self.rows.get(values[0] + "|" + values[1]);
        return row ? { version: row.version } : null;
      },
      run: async () => {
        if (sql.startsWith("INSERT INTO")) {
          const [account, id, ciphertext, updatedAt] = values;
          const key = account + "|" + id;
          if (self.rows.has(key)) return { meta: { changes: 0 } };
          self.rows.set(key, { account_pubkey: String(account), note_id: String(id),
            ciphertext: String(ciphertext), updated_at: Number(updatedAt), version: 1 });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE")) {
          const [ciphertext, updatedAt, account, id, expected] = values;
          const row = self.rows.get(account + "|" + id);
          if (!row || row.version !== Number(expected)) return { meta: { changes: 0 } };
          row.ciphertext = String(ciphertext);
          row.updated_at = Number(updatedAt);
          row.version++;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}
const A = "a".repeat(64), B = "b".repeat(64);
const env = (db: NoteD1) => ({ DB: db } as any);

describe("Worker private-space CAS protocol", () => {
  it("isolates encrypted records by authenticated account and lists pages with stable cursors", async () => {
    const db = new NoteD1();
    const e = env(db);
    await putPrivateSpace(e, A, { id: "note-1", ciphertext: "secret-1", expectedVersion: 0 }, 10);
    await putPrivateSpace(e, A, { id: "note-2", ciphertext: "secret-2", expectedVersion: 0 }, 11);
    await putPrivateSpace(e, B, { id: "note-1", ciphertext: "secret-other", expectedVersion: 0 }, 12);
    expect((await listPrivateSpace(e, A, "", 1))).toEqual({
      items: [{ id: "note-1", version: 1 }], nextCursor: "note-1",
    });
    expect((await listPrivateSpace(e, A, "note-1", 10)).items).toEqual([{ id: "note-2", version: 1 }]);
    expect((await getPrivateSpace(e, A, ["note-1"])).items[0].ciphertext).toBe("secret-1");
    expect((await getPrivateSpace(e, B, ["note-1"])).items[0].ciphertext).toBe("secret-other");
    expect((await getPrivateSpace(e, B, ["note-2"])).items).toEqual([]);
  });

  it("rejects stale edits and invalid IDs and allows only opaque limited ciphertext", async () => {
    const db = new NoteD1();
    const e = env(db);
    await putPrivateSpace(e, A, { id: "note-1", ciphertext: "opaque", expectedVersion: 0 });
    await expect(putPrivateSpace(e, A, { id: "note-1", ciphertext: "stale", expectedVersion: 0 }))
      .rejects.toBeInstanceOf(PrivateSpaceConflict);
    await expect(putPrivateSpace(e, A, { id: "../../oops", ciphertext: "bad", expectedVersion: 0 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(putPrivateSpace(e, A, { id: "new", ciphertext: "x".repeat(256 * 1024 + 1), expectedVersion: 0 }))
      .rejects.toMatchObject({ status: 413 });
    expect(await putPrivateSpace(e, A, { id: "note-1", ciphertext: "v2", expectedVersion: 1 }))
      .toEqual({ id: "note-1", version: 2 });
    expect((await getPrivateSpace(e, A, ["note-1"])).items[0].ciphertext).toBe("v2");
  });
});
