import "fake-indexeddb/auto";
import Dexie from "dexie";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { PrivateSpaceRepository } from "@/repositories/privateSpaceRepository";
import { useSwipeActions } from "@/composables/useSwipeActions";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
const databases: HaiNeiDatabase[] = [];
let sequence = 0;

afterEach(async () => {
  lockLocalVault(ACCOUNT);
  lockLocalVault(OTHER);
  for (const database of databases.splice(0)) {
    database.close();
    await Dexie.delete(database.name);
  }
});

describe("private space list swipe actions", () => {
  it("uses the shared gesture without opening on a vertical scroll, and supports explicit keyboard/mouse opening", () => {
    const swipe = useSwipeActions({ actionWidth: 140, openThreshold: 70 });
    const start = { touches: [{ clientX: 180, clientY: 80 }] } as unknown as TouchEvent;
    const vertical = { touches: [{ clientX: 177, clientY: 160 }], cancelable: true, preventDefault: vi.fn() } as unknown as TouchEvent;
    const horizontal = { touches: [{ clientX: 30, clientY: 83 }], cancelable: true, preventDefault: vi.fn() } as unknown as TouchEvent;
    swipe.onTouchStart(start, "note-1");
    swipe.onTouchMove(vertical, "note-1");
    expect(swipe.isOpen("note-1")).toBe(false);
    expect(vertical.preventDefault).not.toHaveBeenCalled();
    swipe.onTouchCancel("note-1");
    swipe.onTouchStart(start, "note-1");
    swipe.onTouchMove(horizontal, "note-1");
    swipe.onTouchEnd("note-1");
    expect(swipe.swipeStyle("note-1")).toEqual({ transform: "translateX(-140px)" });
    swipe.open("note-2");
    expect(swipe.isOpen("note-1")).toBe(false);
    expect(swipe.isOpen("note-2")).toBe(true);
    swipe.close("note-2");
    expect(swipe.isOpen("note-2")).toBe(false);
  });

  it("only reveals actions on active records and does not bypass confirmation or the trash", () => {
    const view = readFileSync(join(process.cwd(), "src/views/PrivateSpace.vue"), "utf8");
    expect(view).toContain("@touchstart=\"canSwipeNote(note) && onNoteTouchStart($event, note.id)\"");
    expect(view).toContain("@touchmove=\"canSwipeNote(note) && onNoteTouchMove($event, note.id)\"");
    expect(view).toContain("@touchcancel=\"canSwipeNote(note) && onNoteTouchCancel(note.id)\"");
    expect(view).toContain("return !note.deletedAt && !note.archivedAt;");
    expect(view).toContain('@click="openFromList(note)"');
    expect(view).toContain("if (blockedSwipeClickId.value === note.id) return;");
    expect(view).toContain("@click.stop=\"editFromSwipe(note)\"");
    expect(view).toContain("@click.stop=\"deleteFromSwipe(note)\"");
    expect(view).toContain('if (!window.confirm("将「"');
    expect(view).toContain("privateSpaceRepository.moveToTrash(account, note.id)");
    expect(view).toContain("notePrivateSpaceMutation(keys)");
    expect(view).toContain("const { account, isCurrent } = sessionSnapshot()");
    expect(view).toContain("restoreNote(note)");
  });

  it("preserves recoverable trash state and account isolation when deleting a todo", async () => {
    const database = new HaiNeiDatabase("private-space-swipe-test-" + sequence++, true);
    databases.push(database);
    const notes = new PrivateSpaceRepository(database);
    await unlockLocalVault(ACCOUNT, "1".repeat(64));
    await unlockLocalVault(OTHER, "2".repeat(64));
    const record = await notes.createWithContent(ACCOUNT, "note-one", {
      kind: "todo", title: "Buy beans", body: "", pinned: false,
      tasks: [{ id: "task-a", text: "Coffee", done: false }],
    });
    expect((await notes.list(OTHER))).toHaveLength(0);
    const deleted = await notes.moveToTrash(ACCOUNT, record.id);
    expect(deleted.deletedAt).toBeGreaterThan(0);
    expect((await notes.list(ACCOUNT))[0]?.deletedAt).toBe(deleted.deletedAt);
    expect((await notes.list(OTHER))).toHaveLength(0);
    const restored = await notes.update(ACCOUNT, record.id, { deletedAt: 0, archivedAt: 0 });
    expect(restored.deletedAt).toBe(0);
    expect(restored.tasks[0].text).toBe("Coffee");
  });
});
