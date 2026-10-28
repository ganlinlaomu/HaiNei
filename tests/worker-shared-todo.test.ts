import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  SharedTodoConflict, getSharedTodos, leaveSharedTodo, listSharedTodos, putSharedTodo, updateSharedTodoMembers,
} from "../worker/src/sharedTodo";

/** A D1 shim over real SQLite so the Worker's SQL itself is exercised. */
function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../worker/migrations/0008_shared_todos.sql", import.meta.url), "utf8"));
  const statement = (sql: string, values: unknown[] = []): any => ({
    sql, values,
    bind: (...next: unknown[]) => statement(sql, next),
    all: async () => ({ results: sqlite.prepare(sql).all(...(values as any[])) }),
    first: async () => sqlite.prepare(sql).get(...(values as any[])) ?? null,
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(values as any[])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: { sql: string; values: unknown[] }[]) => {
      sqlite.exec("BEGIN");
      try {
        for (const item of statements) sqlite.prepare(item.sql).run(...(item.values as any[]));
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return [];
    },
  };
}
const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
const grant = (pubkey: string) => ({ pubkey, wrappedKey: "wrapped-for-" + pubkey.slice(0, 1) });

describe("Worker shared to-do lists", () => {
  it("creates a list with members who can all read and edit it with compare-and-swap", async () => {
    const env = { DB: sqliteD1() } as any;
    expect(await putSharedTodo(env, A, { id: "list-1", expectedVersion: 0, ciphertext: "v1", members: [grant(A), grant(B)] }, 10))
      .toEqual({ id: "list-1", version: 1 });
    expect((await listSharedTodos(env, B)).items).toEqual([
      { id: "list-1", owner: A, version: 1, wrappedKey: "wrapped-for-b", members: [A, B] },
    ]);
    expect((await getSharedTodos(env, B, ["list-1"])).items).toEqual([{ id: "list-1", version: 1, ciphertext: "v1" }]);
    expect(await putSharedTodo(env, B, { id: "list-1", expectedVersion: 1, ciphertext: "v2" })).toEqual({ id: "list-1", version: 2 });
    await expect(putSharedTodo(env, A, { id: "list-1", expectedVersion: 1, ciphertext: "stale" }))
      .rejects.toMatchObject({ status: 409, currentVersion: 2 });
    expect((await getSharedTodos(env, A, ["list-1"])).items[0].ciphertext).toBe("v2");
  });

  it("hides lists from non-members and refuses their writes", async () => {
    const env = { DB: sqliteD1() } as any;
    await putSharedTodo(env, A, { id: "list-1", expectedVersion: 0, ciphertext: "v1", members: [grant(A), grant(B)] });
    expect((await listSharedTodos(env, C)).items).toEqual([]);
    expect((await getSharedTodos(env, C, ["list-1"])).items).toEqual([]);
    await expect(putSharedTodo(env, C, { id: "list-1", expectedVersion: 1, ciphertext: "x" })).rejects.toMatchObject({ status: 404 });
    // Re-creating someone else's ID neither overwrites it nor reveals its version.
    const takeover = putSharedTodo(env, C, { id: "list-1", expectedVersion: 0, ciphertext: "x", members: [grant(C), grant(B)] });
    await expect(takeover).rejects.toBeInstanceOf(SharedTodoConflict);
    await expect(takeover).rejects.toMatchObject({ currentVersion: 0 });
    expect((await listSharedTodos(env, B)).items.map(item => item.wrappedKey)).toEqual(["wrapped-for-b"]);
    expect((await listSharedTodos(env, C)).items).toEqual([]);
  });

  it("validates creation: owner included, at least one friend, no duplicates", async () => {
    const env = { DB: sqliteD1() } as any;
    await expect(putSharedTodo(env, A, { id: "l", expectedVersion: 0, ciphertext: "v", members: [grant(B)] })).rejects.toMatchObject({ status: 400 });
    await expect(putSharedTodo(env, A, { id: "l", expectedVersion: 0, ciphertext: "v", members: [grant(A)] })).rejects.toMatchObject({ status: 400 });
    await expect(putSharedTodo(env, A, { id: "l", expectedVersion: 0, ciphertext: "v", members: [grant(A), grant(B), grant(B)] })).rejects.toMatchObject({ status: 400 });
    await expect(putSharedTodo(env, A, { id: "../x", expectedVersion: 0, ciphertext: "v", members: [grant(A), grant(B)] })).rejects.toMatchObject({ status: 400 });
  });

  it("lets only the owner change members, and removed members lose access", async () => {
    const env = { DB: sqliteD1() } as any;
    await putSharedTodo(env, A, { id: "list-1", expectedVersion: 0, ciphertext: "v1", members: [grant(A), grant(B)] });
    await expect(updateSharedTodoMembers(env, B, { id: "list-1", add: [grant(C)] })).rejects.toMatchObject({ status: 404 });
    await expect(updateSharedTodoMembers(env, A, { id: "list-1", remove: [A] })).rejects.toMatchObject({ status: 400 });
    expect((await updateSharedTodoMembers(env, A, { id: "list-1", add: [grant(C)] })).members.sort()).toEqual([A, B, C]);
    expect((await listSharedTodos(env, C)).items[0].members).toEqual([A, B, C]);
    await updateSharedTodoMembers(env, A, { id: "list-1", remove: [B] });
    expect((await listSharedTodos(env, B)).items).toEqual([]);
    await expect(putSharedTodo(env, B, { id: "list-1", expectedVersion: 1, ciphertext: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("a member leaves alone; the owner leaving deletes the list for everyone", async () => {
    const env = { DB: sqliteD1() } as any;
    await putSharedTodo(env, A, { id: "list-1", expectedVersion: 0, ciphertext: "v1", members: [grant(A), grant(B), grant(C)] });
    expect(await leaveSharedTodo(env, B, "list-1")).toEqual({ id: "list-1", deleted: false });
    expect((await listSharedTodos(env, B)).items).toEqual([]);
    expect((await listSharedTodos(env, C)).items).toHaveLength(1);
    expect(await leaveSharedTodo(env, A, "list-1")).toEqual({ id: "list-1", deleted: true });
    expect((await listSharedTodos(env, A)).items).toEqual([]);
    expect((await listSharedTodos(env, C)).items).toEqual([]);
  });
});
