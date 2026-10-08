import "fake-indexeddb/auto";
import Dexie from "dexie";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { PrivateSpaceRepository } from "@/repositories/privateSpaceRepository";
import {
  createBackupPayload, encryptPrivateBackup, decryptPrivateBackup,
  exportPlainJson, exportPlainMarkdown, parseBackupPayload,
} from "@/services/privateSpaceBackup";
import { privateNoteSource } from "@/services/privateSpaceSource";

const A = "a".repeat(64), B = "b".repeat(64);
let sequence = 0;
const dbs: HaiNeiDatabase[] = [];
function setup() {
  const database = new HaiNeiDatabase("pr3b-backup-" + sequence++, true);
  dbs.push(database);
  return new PrivateSpaceRepository(database);
}
afterEach(async () => {
  lockLocalVault(A); lockLocalVault(B);
  for (const database of dbs.splice(0)) {
    database.close(); await Dexie.delete(database.name);
  }
});
const PASS = "this is a long independent backup password";

describe("PR3-B account-bound encrypted backups", () => {
  it("roundtrips AES-GCM backup and excludes local CAS + private credentials", async () => {
    const notes = setup();
    await unlockLocalVault(A, "1".repeat(64));
    const created = await notes.create(A, "todo");
    const note = await notes.save(A, created.id, {
      kind: "todo", title: "机密备忘", body: "备份正文", pinned: true,
      tasks: [{ id: "task1", text: "秘密待办", done: false }],
    });
    const output = await encryptPrivateBackup(A, [note], PASS);
    expect(output).not.toContain("机密备忘");
    expect(output).not.toContain("秘密待办");
    expect(output).not.toContain("cloudVersion");
    expect(output).not.toContain("syncedRevision");
    expect(output).not.toContain("skHex");
    const restored = await decryptPrivateBackup(output, A, PASS);
    expect(restored.items).toHaveLength(1);
    expect(restored.items[0].title).toBe("机密备忘");
    expect(restored.items[0].tasks[0].text).toBe("秘密待办");
    expect(restored.items[0].body).toBe("备份正文");
    const second = await encryptPrivateBackup(A, [note], PASS);
    expect(second).not.toBe(output); // independent salt and IV
    await expect(decryptPrivateBackup(output, B, PASS))
      .rejects.toThrow("backup_account_or_version_mismatch");
    await expect(decryptPrivateBackup(output, A, "wrong backup password"))
      .rejects.toThrow("backup_password_or_integrity_failure");
    const tampered = JSON.parse(output);
    tampered.ciphertext = tampered.ciphertext.slice(0, 20) + "AAAA" + tampered.ciphertext.slice(24);
    await expect(decryptPrivateBackup(JSON.stringify(tampered), A, PASS))
      .rejects.toThrow("backup_password_or_integrity_failure");
  }, 30_000);

  it("restores missing entries atomically but preserves local edits, trash and account boundaries", async () => {
    const notes = setup();
    await unlockLocalVault(A, "1".repeat(64));
    await unlockLocalVault(B, "2".repeat(64));
    const first = await notes.create(A, "note");
    await notes.save(A, first.id, { kind: "note", title: "旧标题", body: "备份内容", pinned: false, tasks: [] });
    const removed = await notes.create(A, "todo");
    await notes.moveToTrash(A, removed.id);
    const backup = createBackupPayload(A, await notes.list(A));
    await notes.save(A, first.id, { kind: "note", title: "新标题", body: "本机最新", pinned: true, tasks: [] });
    const before = await notes.get(A, removed.id);
    const duplicate = await notes.restoreBackup(A, backup.items);
    expect(duplicate).toEqual({ added: 0, skipped: 2 });
    expect((await notes.get(A, first.id))?.body).toBe("本机最新");
    expect((await notes.get(A, removed.id))?.deletedAt).toBe(before?.deletedAt);

    const extra = { ...backup.items[0], id: "f".repeat(64), title: "仅备份内有" };
    const mixed = await notes.restoreBackup(A, [...backup.items, extra]);
    expect(mixed).toEqual({ added: 1, skipped: 2 });
    const recovered = await notes.get(A, extra.id);
    expect(recovered).toMatchObject({ title: "仅备份内有", cloudVersion: 0, syncedRevision: 0 });
    expect(await notes.list(B)).toHaveLength(0);
    const other = await notes.create(B, "note");
    expect(other.accountPubkey).toBe(B);
    await expect(notes.restoreBackup(A, [{ ...extra, id: "z".repeat(64) }], () => false))
      .rejects.toThrow("account_changed");
    expect(await notes.get(A, "z".repeat(64))).toBeUndefined();
  });

  it("validates records, duplicates, mismatched accounts, and no private key fields in exports", async () => {
    const notes = setup();
    await unlockLocalVault(A, "1".repeat(64));
    const row = await notes.create(A, "note");
    const record = await notes.save(A, row.id, {
      kind: "note", title: "标题", body: "正文", tasks: [], pinned: false,
    });
    const json = exportPlainJson(A, [record]);
    const md = exportPlainMarkdown(A, [record]);
    expect(json).toContain("标题");
    expect(md).toContain("正文");
    expect(json).not.toContain("cloudVersion");
    expect(json).not.toContain("syncedRevision");
    expect(json).not.toContain("skHex");
    expect(() => parseBackupPayload(json, B)).toThrow("backup_account_or_version_mismatch");
    const obj = JSON.parse(json);
    obj.items.push(obj.items[0]);
    expect(() => parseBackupPayload(JSON.stringify(obj), A)).toThrow("duplicate_backup_id");
    obj.items.pop();
    obj.items[0].tasks = [{ id: "x", text: "one", done: false }, { id: "x", text: "two", done: true }];
    expect(() => parseBackupPayload(JSON.stringify(obj), A)).toThrow("invalid_backup_task");
    expect(() => createBackupPayload(B, [record])).toThrow("backup_account_mismatch");
  });

  it("parses PR3-A source headers without new plaintext indexes", () => {
    const post = privateNoteSource({
      kind: "note", body: [
        "来源：海内动态", "作者：Alice", "作者公钥：" + B,
        "发布时间：2026-10-08T10:00:00.000Z", "消息 ID：" + "c".repeat(64), "", "正文",
      ].join("\n"),
    });
    expect(post).toMatchObject({ kind: "post", author: "Alice", messageId: "c".repeat(64) });
    const dm = privateNoteSource({
      kind: "note", body: [
        "来源：海内普通私信（仅文字）", "发送者：Bob",
        "发送者公钥：" + B, "对话对象：" + B,
        "发送时间：2026-10-08T10:00:00.000Z", "消息 ID：" + "d".repeat(64), "", "普通消息",
      ].join("\n"),
    });
    expect(dm).toMatchObject({ kind: "dm", peerPubkey: B, messageId: "d".repeat(64) });
    expect(privateNoteSource({ kind: "note", body: "随意输入来源：海内动态" })).toBeNull();
  });

  it("provides manual UI flows without changing bottom navigation, DM protocols or schema", () => {
    const settings = readFileSync(join(process.cwd(), "src/views/Settings.vue"), "utf8");
    const view = readFileSync(join(process.cwd(), "src/views/PrivateSpace.vue"), "utf8");
    const dm = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(settings).toContain("quickCreate('note')");
    expect(settings).toContain("quickCreate('todo')");
    expect(view).toContain("确认合并恢复");
    expect(view).toContain("导出加密备份");
    expect(view).toContain("明文文件不加密");
    expect(view).toContain("window.confirm");
    expect(view).toContain("查看原");
    expect(dm).toContain("route.query.focus");
  });
});
