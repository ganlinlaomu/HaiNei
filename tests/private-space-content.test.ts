import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { PrivateSpaceRepository } from "@/repositories/privateSpaceRepository";
import {
  extractPrivateSpaceContent, parseLegacyPrivateSpaceBody, privateSpaceDisplay,
  validatePrivateSpaceAttachments, validatePrivateSpaceSource,
} from "@/services/privateSpaceContent";
import { importPostToPrivateSpace, importDirectMessageToPrivateSpace } from "@/services/privateSpaceImport";
import { exportPlainJson, parseBackupPayload } from "@/services/privateSpaceBackup";

const A = "a".repeat(64), PEER = "c".repeat(64);
const ID = "d".repeat(64), DM_ID = "e".repeat(64);
const AUTH = { pkHex: A, isUnlocked: true, sessionGeneration: 1 };
let seq = 0;
const dbs: HaiNeiDatabase[] = [];
function makeRepo() {
  const database = new HaiNeiDatabase("private-space-content-test-" + seq++, true);
  dbs.push(database);
  return { database, notes: new PrivateSpaceRepository(database) };
}
afterEach(async () => {
  lockLocalVault(A);
  for (const db of dbs.splice(0)) {
    db.close(); await Dexie.delete(db.name);
  }
});

describe("PR-FIX-B excerpt semantics", () => {
  it("strips inline media and video JSON from feed body while keeping typed attachments", () => {
    const raw = [
      "今日咖啡非常好喝",
      "![cup](https://images.example/cup.jpg)",
      "![encrypted](blossom+aesgcm:123456)",
      '[video:{"type":"video","url":"https://video.example/clip.mp4","provider":"Direct"}]',
    ].join("\n");
    const parsed = extractPrivateSpaceContent(raw);
    expect(parsed.text).toBe("今日咖啡非常好喝");
    expect(parsed.attachments).toEqual([
      { kind: "image", url: "https://images.example/cup.jpg" },
      { kind: "image", url: "blossom+aesgcm:123456" },
      { kind: "video", url: "https://video.example/clip.mp4" },
    ]);
    expect(extractPrivateSpaceContent(raw, false).attachments).toEqual([]);
    expect(extractPrivateSpaceContent(raw, false).text).toBe("今日咖啡非常好喝");
  });

  it("unwraps only a complete serialized Nostr event, not arbitrary user JSON", () => {
    const envelope = JSON.stringify({
      id: ID, kind: 1, pubkey: PEER, created_at: 1_760_000_000,
      tags: [], sig: "f".repeat(128),
      content: "真正的文字\\n![pic](https://img.example/photo.png)",
    });
    const extracted = extractPrivateSpaceContent(envelope);
    expect(extracted.text).toBe("真正的文字");
    expect(extracted.attachments).toEqual([{ kind: "image", url: "https://img.example/photo.png" }]);
    const ordinary = JSON.stringify({ content: "普通 JSON，不能误拆", another: true });
    expect(extractPrivateSpaceContent(ordinary).text).toBe(ordinary);
  });

  it("stores clean excerpt and source separately; duplicate import cannot overwrite edits or archived note", async () => {
    const { database, notes } = makeRepo();
    await unlockLocalVault(A, "1".repeat(64));
    const content = "一段有用的文字\n![photo](https://images.example/post.png)";
    const msg = { id: ID, pubkey: PEER, created_at: 1_760_000_000,
      tags: [["t", "hainei-post"]], content };
    const result = await importPostToPrivateSpace(AUTH, msg, "好友", notes);
    const stored = await notes.get(A, result.id);
    expect(stored?.title).toContain("一段有用的文字");
    expect(stored?.body).toBe("一段有用的文字");
    expect(stored?.source).toMatchObject({
      kind: "post", messageId: ID, author: "好友", authorPubkey: PEER,
    });
    expect(stored?.attachments).toEqual([{ kind: "image", url: "https://images.example/post.png" }]);
    const raw: any = await new Promise((resolve, reject) => {
      const tx = database.backendDB().transaction("accountNotes", "readonly");
      const req = tx.objectStore("accountNotes").get([A, result.id]);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(JSON.stringify(raw)).not.toContain("images.example");
    expect(JSON.stringify(raw)).not.toContain("好友");
    expect(JSON.stringify(raw)).not.toContain(ID);

    await notes.save(A, result.id, {
      kind: "note", title: "自己写的标题", body: "我的修改",
      pinned: false, tasks: [], source: stored!.source, attachments: stored!.attachments,
    });
    const repeat = await importPostToPrivateSpace(AUTH, msg, "第二个作者名", notes);
    expect(repeat).toEqual({ id: result.id, created: false });
    expect((await notes.get(A, result.id))?.body).toBe("我的修改");
    expect((await notes.get(A, result.id))?.source?.author).toBe("好友");
  });

  it("can display legacy headers without mutating the database and preserve source after text edits", async () => {
    const { notes } = makeRepo();
    await unlockLocalVault(A, "1".repeat(64));
    const sourceBody = [
      "来源：海内动态", "作者：甲", "作者公钥：" + PEER,
      "发布时间：2026-10-08T10:00:00.000Z", "消息 ID：" + ID, "",
      "正文内容", "![photo](https://img.example/post.jpg)",
    ].join("\n");
    const legacy = await notes.create(A, "note");
    await notes.save(A, legacy.id, {
      kind: "note", title: "旧摘录", body: sourceBody, tasks: [], pinned: false,
    });
    const projection = privateSpaceDisplay((await notes.get(A, legacy.id))!);
    expect(projection.text).toBe("正文内容");
    expect(projection.source).toMatchObject({ kind: "post", messageId: ID, author: "甲" });
    expect(projection.attachments).toEqual([{ kind: "image", url: "https://img.example/post.jpg" }]);
    expect((await notes.get(A, legacy.id))?.body).toBe(sourceBody); // read-only
    await notes.save(A, legacy.id, {
      kind: "note", title: "我编辑后的标题", body: "新的正文", tasks: [], pinned: false,
      source: projection.source, attachments: projection.attachments,
    });
    expect(privateSpaceDisplay((await notes.get(A, legacy.id))!).source?.messageId).toBe(ID);
  });

  it("keeps DM text-only, without storing raw media references or transport payload", async () => {
    const { notes } = makeRepo();
    await unlockLocalVault(A, "1".repeat(64));
    const msg = {
      id: DM_ID, pubkey: PEER, created_at: 1_760_000_000,
      tags: [["t", "hainei-dm"]],
      content: "请记住\n![image](blossom+aesgcm:secretLongKey)",
    };
    const result = await importDirectMessageToPrivateSpace(AUTH, msg, PEER, "朋友", false, notes);
    const record = (await notes.get(A, result.id))!;
    expect(record.body).toBe("请记住");
    expect(record.attachments).toBeUndefined();
    expect(record.source).toMatchObject({ kind: "dm", peerPubkey: PEER, messageId: DM_ID });
    expect(record.body).not.toContain("blossom");
    expect(record.body).not.toContain(PEER);
  });

  it("rejects malformed source or unsafe attachment links, and includes encrypted fields in export", async () => {
    const { notes } = makeRepo();
    await unlockLocalVault(A, "1".repeat(64));
    expect(() => validatePrivateSpaceSource({ kind: "dm", messageId: ID, author: "A", date: "" }))
      .toThrow("invalid_private_space_source");
    expect(() => validatePrivateSpaceAttachments([{ kind: "image", url: "javascript:alert(1)" }]))
      .toThrow("invalid_private_space_attachment");
    const imported = await importPostToPrivateSpace(AUTH, {
      id: ID, pubkey: PEER, created_at: 1_760_000_000, content: "你好",
      tags: [["t", "hainei-post"]],
    }, "朋友", notes);
    const json = exportPlainJson(A, await notes.list(A));
    const parsed = parseBackupPayload(json, A);
    expect(parsed.items.find(row => row.id === imported.id)?.source?.messageId).toBe(ID);
    expect(json).not.toContain("cloudVersion");
    expect(json).not.toContain("syncedRevision");
  });

  it("does not interpret arbitrary note text as legacy source", () => {
    expect(parseLegacyPrivateSpaceBody("来源：海内动态\n\n随意文字")).toBeNull();
    expect(privateSpaceDisplay({ body: "普通笔记" })).toEqual({
      text: "普通笔记", attachments: [],
    });
  });
});
