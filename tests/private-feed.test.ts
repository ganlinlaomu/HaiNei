import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PrivateSpaceRecord } from "@/db/dexie";
import { PRIVATE_FEED_PREFIX, privateFeedItems } from "@/services/privateFeed";

const OWNER = "a".repeat(64);
const record = (id: string, patch: Partial<PrivateSpaceRecord> = {}): PrivateSpaceRecord => ({
  accountPubkey: OWNER, id, kind: "note", title: "", body: "", tasks: [], pinned: false,
  createdAt: 1_790_000_000_000, updatedAt: 1_790_000_000_000, revision: 1, ...patch,
});
const task = (text: string, done = false) => ({ id: text, text, done });

describe("private cards in the owner's feed", () => {
  it("shows notes with content and each open to-do list as one card", () => {
    const items = privateFeedItems([
      record("note", { body: "今天的想法" }),
      record("photo-note", { attachments: [{ kind: "image", url: "blossom+aesgcm:x" }] }),
      record("todo", { kind: "todo", tasks: [task("买菜"), task("取快递"), task("交电费", true)] }),
    ], OWNER);
    expect(items.map(item => item.id)).toEqual(["note", "photo-note", "todo"].map(id => `${PRIVATE_FEED_PREFIX}${id}`));
    expect(items[0]).toMatchObject({ pubkey: OWNER, created_at: 1_790_000_000, content: "" });
    expect(items[2].privateNote?.tasks).toHaveLength(3);
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
  });
});
