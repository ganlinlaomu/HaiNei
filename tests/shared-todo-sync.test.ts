import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, nip44, utils } from "nostr-tools";
import { db } from "@/db/dexie";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { privateSpaceRepository } from "@/repositories/privateSpaceRepository";
import {
  leaveTodoList, shareTodoList, synchronizeSharedTodos, updateTodoMembers,
} from "@/services/sharedTodoSync";
import { cancelPrivateSpaceSync, getPrivateSpaceSyncState, syncPrivateSpace } from "@/services/privateSpaceSync";
import { mergeSharedTodo } from "@/utils/sharedTodoMerge";
import * as worker from "../worker/src/sharedTodo";

const secrets = ["1".repeat(64), "2".repeat(64), "3".repeat(64)].map(utils.hexToBytes);
const [A, B, C] = secrets.map(secret => getPublicKey(secret));

function keysFor(index: number) {
  const secret = secrets[index];
  return {
    pkHex: getPublicKey(secret), sessionGeneration: 1, isUnlocked: true, supportsNip44: true,
    nip44Encrypt: async (peer: string, text: string) => nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(secret, peer)),
    nip44Decrypt: async (peer: string, text: string) => nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(secret, peer)),
    signEvent: async (event: any) => finalizeEvent(event, secret),
  };
}
const options = (trusted = true) => ({
  isCurrent: () => true, isTrustedOwner: () => trusted, isEditing: () => false,
});

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
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      return [];
    },
  };
}

let env: any;
let ciphertexts: string[];
let privatePuts: string[];
function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
beforeEach(async () => {
  env = { DB: sqliteD1() };
  ciphertexts = [];
  privatePuts = [];
  vi.stubGlobal("window", { location: { origin: "https://worker.test" }, dispatchEvent: vi.fn() });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", vi.fn(async (raw: string, init?: RequestInit) => {
    const path = new URL(raw).pathname;
    if (path === "/api/auth/challenge") return json({ challenge: "0".repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 300 }, 201);
    const body = JSON.parse(String(init?.body || "{}"));
    const account = body.event.pubkey as string;
    if (path === "/api/private-space/list") return json({ items: [], nextCursor: null });
    if (path === "/api/private-space/put") {
      privatePuts.push(body.id);
      return json({ id: body.id, version: Number(body.expectedVersion) + 1 });
    }
    try {
      if (path === "/api/shared-todo/list") return json(await worker.listSharedTodos(env, account));
      if (path === "/api/shared-todo/get") return json(await worker.getSharedTodos(env, account, body.ids));
      if (path === "/api/shared-todo/put") {
        ciphertexts.push(body.ciphertext);
        return json(await worker.putSharedTodo(env, account, body));
      }
      if (path === "/api/shared-todo/members") return json(await worker.updateSharedTodoMembers(env, account, body));
      if (path === "/api/shared-todo/leave") return json(await worker.leaveSharedTodo(env, account, body.id));
    } catch (error: any) {
      return json({ error: error.message, currentVersion: error.currentVersion }, error.status || 500);
    }
    throw new Error("Unexpected Worker route: " + path);
  }));
  await db.open();
  for (const [index, account] of [A, B, C].entries()) {
    await unlockLocalVault(account, utils.bytesToHex(secrets[index]));
    await db.accountNotes.where("accountPubkey").equals(account).delete();
  }
});
afterEach(() => {
  for (const account of [A, B, C]) { cancelPrivateSpaceSync(account); lockLocalVault(account); }
  vi.unstubAllGlobals();
});

async function ownedList(title: string, tasks: { id: string; text: string; done?: boolean }[]) {
  return privateSpaceRepository.createWithContent(A, "list-" + Math.random().toString(36).slice(2), {
    kind: "todo", title, body: "", pinned: false,
    tasks: tasks.map(task => ({ done: false, ...task })),
  });
}
const texts = async (account: string, id: string) =>
  (await privateSpaceRepository.get(account, id))?.tasks.map(task => (task.done ? "✓" : "") + task.text);

describe("shared to-do lists between accounts", () => {
  it("a friend sees a shared list and both can edit it; the Worker only stores ciphertext", async () => {
    const list = await ownedList("周末采购", [{ id: "t1", text: "买牛奶" }, { id: "t2", text: "买鸡蛋" }]);
    const shared = await shareTodoList(keysFor(0), list.id, [B]);
    expect(shared.share).toMatchObject({ owner: A, members: [A, B], version: 1 });

    await synchronizeSharedTodos(keysFor(1), options());
    const received = await privateSpaceRepository.get(B, list.id);
    expect(received).toMatchObject({ kind: "todo", title: "周末采购", share: { owner: A, version: 1 } });

    const tasks = received!.tasks.map(task => task.id === "t1" ? { ...task, done: true } : task);
    await privateSpaceRepository.update(B, list.id, { tasks: [...tasks, { id: "t3", text: "买面包", done: false }] });
    expect((await synchronizeSharedTodos(keysFor(1), options())).pending).toBe(false);
    await synchronizeSharedTodos(keysFor(0), options());
    expect(await texts(A, list.id)).toEqual(["✓买牛奶", "买鸡蛋", "买面包"]);
    expect(ciphertexts.some(value => /牛奶|周末|面包/.test(value))).toBe(false);
  });

  it("merges concurrent edits from both sides instead of overwriting", async () => {
    const list = await ownedList("家务", [{ id: "t1", text: "洗碗" }, { id: "t2", text: "拖地" }]);
    await shareTodoList(keysFor(0), list.id, [B]);
    await synchronizeSharedTodos(keysFor(1), options());

    const mine = (await privateSpaceRepository.get(A, list.id))!;
    await privateSpaceRepository.update(A, list.id, {
      tasks: mine.tasks.map(task => task.id === "t1" ? { ...task, text: "洗碗和锅" } : task),
    });
    const theirs = (await privateSpaceRepository.get(B, list.id))!;
    await privateSpaceRepository.update(B, list.id, {
      title: "本周家务",
      tasks: [...theirs.tasks.map(task => task.id === "t2" ? { ...task, done: true } : task), { id: "t3", text: "倒垃圾", done: false }],
    });
    await synchronizeSharedTodos(keysFor(0), options());
    await synchronizeSharedTodos(keysFor(1), options()); // 409, merge, republish
    await synchronizeSharedTodos(keysFor(0), options());
    for (const account of [A, B]) {
      expect((await privateSpaceRepository.get(account, list.id))?.title).toBe("本周家务");
      expect(await texts(account, list.id)).toEqual(["洗碗和锅", "✓拖地", "倒垃圾"]);
    }
  });

  it("ignores lists from people who are not accepted friends", async () => {
    const list = await ownedList("陌生人", [{ id: "t1", text: "x" }]);
    await shareTodoList(keysFor(0), list.id, [B]);
    await synchronizeSharedTodos(keysFor(1), options(false));
    expect(await privateSpaceRepository.get(B, list.id)).toBeUndefined();
  });

  it("deleting as a member leaves the list; the owner and others keep it", async () => {
    const list = await ownedList("聚会", [{ id: "t1", text: "订位" }]);
    await shareTodoList(keysFor(0), list.id, [B, C]);
    await synchronizeSharedTodos(keysFor(1), options());
    await privateSpaceRepository.moveToTrash(B, list.id);
    await synchronizeSharedTodos(keysFor(1), options());
    const left = await privateSpaceRepository.get(B, list.id);
    expect(left?.share).toBeUndefined();
    expect(left?.deletedAt).toBeGreaterThan(0);
    await synchronizeSharedTodos(keysFor(0), options());
    expect((await privateSpaceRepository.get(A, list.id))?.share?.members).toEqual([A, C]);
  });

  it("stopping or removing turns members' copies back into private lists", async () => {
    const list = await ownedList("旅行", [{ id: "t1", text: "订机票" }]);
    await shareTodoList(keysFor(0), list.id, [B, C]);
    await synchronizeSharedTodos(keysFor(1), options());
    await synchronizeSharedTodos(keysFor(2), options());

    await updateTodoMembers(keysFor(0), list.id, [], [C]);
    await synchronizeSharedTodos(keysFor(2), options());
    const removed = await privateSpaceRepository.get(C, list.id);
    expect(removed?.title).toBe("旅行");
    expect(removed?.share).toBeUndefined();

    const stopped = await leaveTodoList(keysFor(0), list.id);
    expect(stopped?.share).toBeUndefined();
    expect(stopped?.deletedAt).toBeFalsy();
    await synchronizeSharedTodos(keysFor(1), options());
    const copy = await privateSpaceRepository.get(B, list.id);
    expect(copy?.share).toBeUndefined();
    expect(copy?.deletedAt).toBeFalsy();
    expect(await texts(B, list.id)).toEqual(["订机票"]);
  });

  it("private sync never uploads a shared list to the account's private store", async () => {
    const list = await ownedList("共享", [{ id: "t1", text: "a" }]);
    await syncPrivateSpace(keysFor(0));
    privatePuts = [];
    await shareTodoList(keysFor(0), list.id, [B]);
    await privateSpaceRepository.update(A, list.id, { pinned: true });
    await syncPrivateSpace(keysFor(0));
    expect(privatePuts).not.toContain(list.id);
    expect(getPrivateSpaceSyncState(A).status).toBe("synced");
  });
});

describe("mergeSharedTodo", () => {
  const task = (id: string, text: string, done = false) => ({ id, text, done });
  it("keeps edits from both sides and prefers an edit over a delete", () => {
    const base = { title: "T", tasks: [task("1", "a"), task("2", "b"), task("3", "c")] };
    const local = { title: "T", tasks: [task("1", "a2"), task("3", "c"), task("4", "new local")] };
    const remote = { title: "T remote", tasks: [task("1", "a"), task("2", "b", true), task("5", "new remote")] };
    expect(mergeSharedTodo(base, local, remote)).toEqual({
      title: "T remote",
      // 2 deleted locally but edited remotely → kept; 3 deleted remotely, untouched locally → gone.
      tasks: [task("1", "a2"), task("4", "new local"), task("2", "b", true), task("5", "new remote")],
    });
  });
  it("places a local addition after the task it followed", () => {
    const base = { title: "", tasks: [task("1", "a"), task("2", "b")] };
    const local = { title: "", tasks: [task("1", "a"), task("x", "x"), task("2", "b")] };
    const remote = { title: "", tasks: [task("0", "z"), task("1", "a"), task("2", "b")] };
    expect(mergeSharedTodo(base, local, remote).tasks.map(item => item.id)).toEqual(["0", "1", "x", "2"]);
  });
});
