import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFeedRenderableMessage, syncedMessageRecordToInboxItem } from "@/nostr/messaging/messageViewModel";
import type { SyncedMessageRecord } from "@/db/dexie";
import { getPrivateSpaceTab, rememberPrivateSpaceTab } from "@/services/privateSpaceNavigation";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const fakeRecord = (tags: string[][]): SyncedMessageRecord => ({
  accountPubkey: "a".repeat(64),
  id: "b".repeat(64),
  senderPubkey: "c".repeat(64),
  recipientPubkeys: ["a".repeat(64)],
  conversationId: "group",
  plaintext: "bookmarked content",
  createdAt: 1791624601,
  protocol: "nip17",
  transportKind: 1059,
  transportEventIds: [],
  tags,
  firstSeenAt: 1,
  lastSeenAt: 1,
});

describe("private space unified navigation", () => {
  it("remembers the last main tab per account only in memory", () => {
    const first = "f".repeat(64);
    const other = "e".repeat(64);
    expect(getPrivateSpaceTab(first)).toBe("saved");
    rememberPrivateSpaceTab(first, "todo");
    expect(getPrivateSpaceTab(first)).toBe("todo");
    expect(getPrivateSpaceTab(other)).toBe("saved");
    rememberPrivateSpaceTab(first, "saved");
  });
  it("has one entry in My and forwards legacy saved links into the saved category", () => {
    const settings = source("src/views/Settings.vue");
    const router = source("src/router/index.ts");
    expect(settings).toContain("收藏 · 笔记 · 待办");
    expect(settings).not.toContain('aria-label="私人空间快捷添加"');
    expect(settings).not.toContain("<strong>已收藏</strong>");
    expect(router).toContain('path: "/settings/saved"');
    expect(router).toContain('redirect: { path: "/settings/private-space", query: { tab: "saved" } }');
  });

  it("keeps saved posts as a tab without rewriting the note/todo repository", () => {
    const privateSpace = source("src/views/PrivateSpace.vue");
    expect(privateSpace).toContain('{ value: "saved", label: "收藏" }');
    expect(privateSpace).toContain('{ value: "note", label: "笔记" }');
    expect(privateSpace).toContain('{ value: "todo", label: "待办" }');
    expect(privateSpace).toContain('<SavedPosts v-if="filter === \'saved\'" :query="query" />');
    expect(privateSpace).toContain("privateSpaceRepository.list(account)");
    expect(privateSpace).toContain("privateSpaceRepository.moveToTrash");
    expect(privateSpace).toContain("consumeQuickCreate(route.query.new, true)");
    expect(privateSpace).toContain("归档");
    expect(privateSpace).toContain("最近删除");
    expect(privateSpace).toContain("备份 / 恢复");
  });

  it("removes repetitive sync/privacy banners without changing storage behavior", () => {
    const privateSpace = source("src/views/PrivateSpace.vue");
    const saved = source("src/components/SavedPosts.vue");
    const oldSaved = source("src/views/Saved.vue");
    for (const rendered of [privateSpace, saved, oldSaved]) {
      expect(rendered).not.toContain("收藏会先保存在本机");
      expect(rendered).not.toContain("本地与云端均加密");
      expect(rendered).not.toContain("已加密同步至云端");
      expect(rendered).not.toContain("privacy-line");
      expect(rendered).not.toContain("cloud-status");
    }
    expect(privateSpace).toContain("syncPrivateSpace(keys)");
    expect(saved).toContain("bookmarks.load(account)");
  });

  it("keeps 收藏、笔记、待办 the same fixed height", () => {
    const privateSpace = source("src/views/PrivateSpace.vue");
    expect(privateSpace).toContain("grid-template-columns:repeat(3,minmax(0,1fr))");
    expect(privateSpace).toContain("height:42px;min-height:42px");
    expect(privateSpace).toContain("align-items:center;justify-content:center;width:100%");
    expect(privateSpace).toContain('role="tablist"');
  });

  it("uses the account-scoped encrypted local message repository for older bookmarks", () => {
    const saved = source("src/components/SavedPosts.vue");
    expect(saved).toContain("syncedMessageRepository.get(account, id)");
    expect(saved).toContain("bookmarks.load(account)");
    expect(saved).toContain("keys.isUnlocked");
    expect(saved).toContain("run === generation");
    expect(saved).toContain("isFeedRenderableMessage(message)");
    expect(saved).toContain("此设备尚未取得原文");
    expect(saved).toContain("resumeAccountMessageSync(\"manual\")");
    expect(saved).not.toContain("bookmarks.toggle(row.id)");
  });

  it("renders bookmarked posts but not NIP-17 direct messages or controls", () => {
    expect(isFeedRenderableMessage(syncedMessageRecordToInboxItem(fakeRecord([["t", "hainei-post"]])))).toBe(true);
    expect(isFeedRenderableMessage(syncedMessageRecordToInboxItem(fakeRecord([["t", "hainei-dm"]])))).toBe(false);
    expect(isFeedRenderableMessage(syncedMessageRecordToInboxItem(fakeRecord([["t", "hainei-dm-burn"]])))).toBe(false);
  });
});
