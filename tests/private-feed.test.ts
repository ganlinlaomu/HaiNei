import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PrivateSpaceRecord } from "@/db/dexie";
import { openTodoTasks, PRIVATE_FEED_PREFIX, privateFeedItems } from "@/services/privateFeed";

const OWNER = "a".repeat(64);
const record = (id: string, patch: Partial<PrivateSpaceRecord> = {}): PrivateSpaceRecord => ({
  accountPubkey: OWNER, id, kind: "note", title: "", body: "", tasks: [], pinned: false,
  createdAt: 1_790_000_000_000, updatedAt: 1_790_000_000_000, revision: 1, ...patch,
});
const task = (text: string, done = false) => ({ id: text, text, done });

describe("private cards in the owner's feed", () => {
  it("shows notes with content as feed cards; to-dos go to the to-do bar instead", () => {
    const items = privateFeedItems([
      record("note", { body: "今天的想法" }),
      record("photo-note", { attachments: [{ kind: "image", url: "blossom+aesgcm:x" }] }),
      record("todo", { kind: "todo", tasks: [task("买菜"), task("取快递"), task("交电费", true)] }),
    ], OWNER);
    expect(items.map(item => item.id)).toEqual(["note", "photo-note"].map(id => `${PRIVATE_FEED_PREFIX}${id}`));
    expect(items[0]).toMatchObject({ pubkey: OWNER, created_at: 1_790_000_000, content: "" });
  });

  it("lists every open task for the to-do bar, pinned lists first then most recently edited", () => {
    const tasks = openTodoTasks([
      record("older", { kind: "todo", title: "购物", updatedAt: 1, tasks: [task("买菜"), task("交电费", true)] }),
      record("newer", { kind: "todo", updatedAt: 3, tasks: [task("取快递"), task("  ")] }),
      record("pinned", { kind: "todo", title: "生活", pinned: true, updatedAt: 2, tasks: [task("交房租")] }),
      record("note", { body: "不是待办" }),
      record("archived", { kind: "todo", archivedAt: 1, tasks: [task("旧事")] }),
    ]);
    expect(tasks.map(item => item.text)).toEqual(["交房租", "取快递", "买菜"]);
    expect(tasks[0]).toEqual({ recordId: "pinned", taskId: "交房租", text: "交房租", listTitle: "生活", pinned: true });
  });

  it("marks tasks from a list shared with friends", () => {
    const share = { owner: OWNER, members: [OWNER, "b".repeat(64)], key: "k", version: 1, syncedRevision: 1, base: { title: "", tasks: [] } };
    const tasks = openTodoTasks([
      record("shared", { kind: "todo", title: "家务", tasks: [task("洗碗")], share }),
      record("mine", { kind: "todo", tasks: [task("看书")] }),
    ]);
    expect(tasks.find(item => item.text === "洗碗")?.shared).toBe(true);
    expect(tasks.find(item => item.text === "看书")).not.toHaveProperty("shared");
  });

  it("leaves out empty, archived, deleted and finished items", () => {
    expect(privateFeedItems([
      record("blank"),
      record("archived", { body: "x", archivedAt: 1 }),
      record("deleted", { body: "x", deletedAt: 1 }),
      record("finished", { kind: "todo", tasks: [task("买菜", true)] }),
      record("blank-tasks", { kind: "todo", tasks: [task("  ")] }),
    ], OWNER)).toEqual([]);
  });

  it("is wired into Home and opens the matching note in 私人空间", () => {
    const home = readFileSync("src/views/Home.vue", "utf8");
    expect(home).toContain('<PrivateNoteCard v-if="m.privateNote" :item="m" @height="recordPostHeight" />');
    expect(home).toContain("...privateCards.value,");
    expect(home).toContain("function applyPrivateCards()");
    const card = readFileSync("src/components/PrivateNoteCard.vue", "utf8");
    expect(card).toContain('query: { tab: record.value.kind, open: record.value.id }');
    expect(card).toContain("const current = await privateSpaceRepository.get(account, record.value.id);");
    expect(readFileSync("src/views/PrivateSpace.vue", "utf8")).toContain('route.query.open && !note.deletedAt');
    // The to-do bar sits above the feed, fed by the same single read.
    expect(home).toContain('<HomeTodoBar :tasks="privateTodos" />');
    const bar = readFileSync("src/components/HomeTodoBar.vue", "utf8");
    expect(bar).toContain('query: { tab: "todo", open: task.recordId }');
    expect(bar).toContain("const current = await privateSpaceRepository.get(account, task.recordId);");
    expect(bar).toContain("ui.openPostEditor('todo')");
    expect(readFileSync("src/composables/usePrivateFeedCards.ts", "utf8")).toContain('startupMark("todo_bar_ready"');
  });
});
