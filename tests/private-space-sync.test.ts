import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, nip44, utils } from "nostr-tools";
import { db } from "@/db/dexie";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { privateSpaceRepository } from "@/repositories/privateSpaceRepository";
import {
  cancelPrivateSpaceSync, getPrivateSpaceSyncState, syncPrivateSpace,
} from "@/services/privateSpaceSync";

const SECRET = "1".repeat(64);
const SECRET_BYTES = utils.hexToBytes(SECRET);
const ACCOUNT = getPublicKey(SECRET_BYTES);
const conversationKey = nip44.v2.utils.getConversationKey(SECRET_BYTES, ACCOUNT);
type Cloud = { ciphertext: string; version: number };
let cloud: Map<string, Cloud>;

function keys() {
  return {
    pkHex: ACCOUNT, sessionGeneration: 1, isUnlocked: true, supportsNip44: true,
    nip44Encrypt: async (_peer: string, text: string) => nip44.v2.encrypt(text, conversationKey),
    nip44Decrypt: async (_peer: string, text: string) => nip44.v2.decrypt(text, conversationKey),
    signEvent: async (event: any) => finalizeEvent(event, SECRET_BYTES),
  };
}
function result(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
function mockWorker() {
  const calls = vi.fn(async (raw: string, options?: RequestInit) => {
    const path = new URL(raw).pathname;
    if (path === "/api/auth/challenge") {
      return result({ challenge: "0".repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 300 }, 201);
    }
    const body = JSON.parse(String(options?.body || "{}"));
    if (path === "/api/private-space/list") {
      const sorted = [...cloud].filter(([id]) => id > (body.after || ""))
        .sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({ id, version: value.version }));
      const limit = Number(body.limit);
      return result({ items: sorted.slice(0, limit),
        nextCursor: sorted.length > limit ? sorted[limit - 1].id : null });
    }
    if (path === "/api/private-space/get") {
      return result({ items: body.ids.flatMap((id: string) => cloud.has(id)
        ? [{ id, ...cloud.get(id)! }] : []) });
    }
    if (path === "/api/private-space/put") {
      const value = cloud.get(body.id);
      if (Number(body.expectedVersion) !== (value?.version || 0)) {
        return result({ error: "private_space_conflict", currentVersion: value?.version || 0 }, 409);
      }
      const version = (value?.version || 0) + 1;
      cloud.set(body.id, { version, ciphertext: body.ciphertext });
      return result({ id: body.id, version });
    }
    throw new Error("Unexpected Worker route: " + path);
  });
  vi.stubGlobal("fetch", calls);
  return calls;
}
beforeEach(async () => {
  cloud = new Map();
  vi.stubGlobal("window", { location: { origin: "https://worker.test" }, dispatchEvent: vi.fn() });
  vi.stubGlobal("navigator", { onLine: true });
  mockWorker();
  await db.open();
  await unlockLocalVault(ACCOUNT, SECRET);
  await db.accountNotes.where("accountPubkey").equals(ACCOUNT).delete();
});
afterEach(async () => {
  cancelPrivateSpaceSync(ACCOUNT);
  lockLocalVault(ACCOUNT);
  vi.unstubAllGlobals();
});

describe("private space NIP-44 cloud reconciliation", () => {
  it("uploads only ciphertext, confirms exact revision and restores notes on a new device", async () => {
    const note = await privateSpaceRepository.create(ACCOUNT, "note");
    await privateSpaceRepository.save(ACCOUNT, note.id, {
      kind: "note", title: "Sensitive headline", body: "Private secret", tasks: [], pinned: false,
    });
    await syncPrivateSpace(keys());
    expect(getPrivateSpaceSyncState(ACCOUNT).status).toBe("synced");
    expect(cloud.get(note.id)?.ciphertext).not.toContain("Sensitive headline");
    expect((await privateSpaceRepository.get(ACCOUNT, note.id))?.cloudVersion).toBe(1);
    expect((await privateSpaceRepository.get(ACCOUNT, note.id))?.syncedRevision).toBe(2);

    await db.accountNotes.delete([ACCOUNT, note.id]); // Simulate a different empty device.
    await syncPrivateSpace(keys());
    const restored = await privateSpaceRepository.get(ACCOUNT, note.id);
    expect(restored).toMatchObject({
      title: "Sensitive headline", body: "Private secret", cloudVersion: 1, syncedRevision: 2,
    });
  });

  it("keeps both edits when a second device changes the same note", async () => {
    const note = await privateSpaceRepository.create(ACCOUNT, "note");
    await privateSpaceRepository.save(ACCOUNT, note.id, {
      kind: "note", title: "Base", body: "", tasks: [], pinned: false,
    });
    await syncPrivateSpace(keys());
    await privateSpaceRepository.save(ACCOUNT, note.id, {
      kind: "note", title: "Local changes", body: "Unpublished", tasks: [], pinned: false,
    });
    const old = cloud.get(note.id)!;
    const envelope = JSON.parse(await keys().nip44Decrypt(ACCOUNT, old.ciphertext));
    envelope.note.title = "Other device changes";
    envelope.note.revision = 3;
    cloud.set(note.id, { version: 2, ciphertext: await keys().nip44Encrypt(ACCOUNT, JSON.stringify(envelope)) });
    await syncPrivateSpace(keys());
    const local = await privateSpaceRepository.list(ACCOUNT);
    expect(local).toHaveLength(2);
    expect(local.find(item => item.id === note.id)?.title).toBe("Other device changes");
    expect(local.find(item => item.id !== note.id)?.title).toContain("Local changes");
    expect(local.find(item => item.id !== note.id)?.cloudVersion).toBe(1);
    expect(getPrivateSpaceSyncState(ACCOUNT).conflicts).toBe(1);
    await syncPrivateSpace(keys());
    expect((await privateSpaceRepository.list(ACCOUNT))).toHaveLength(2);
  });

  it("roundtrips optional encrypted excerpt metadata across cloud and fresh device", async () => {
    const id = "d".repeat(64), author = "e".repeat(64);
    const created = await privateSpaceRepository.importNote(
      ACCOUNT, id, "摘录内容", "正文", {
        source: { kind: "post", messageId: id, author: "好友", authorPubkey: author, date: "2026-10-08" },
        attachments: [{ kind: "image", url: "https://img.example/post.jpg" }],
      },
    );
    expect(created.created).toBe(true);
    await syncPrivateSpace(keys());
    expect(cloud.get(id)?.ciphertext).not.toContain("img.example");
    await db.accountNotes.delete([ACCOUNT, id]);
    await syncPrivateSpace(keys());
    const downloaded = await privateSpaceRepository.get(ACCOUNT, id);
    expect(downloaded?.body).toBe("正文");
    expect(downloaded?.source?.messageId).toBe(id);
    expect(downloaded?.source?.author).toBe("好友");
    expect(downloaded?.attachments).toEqual([{ kind: "image", url: "https://img.example/post.jpg" }]);
  });

  it("reconciles identical backup restores with cloud without artificial conflict copies", async () => {
    const note = await privateSpaceRepository.create(ACCOUNT, "note");
    const original = await privateSpaceRepository.save(ACCOUNT, note.id, {
      kind: "note", title: "恢复前", body: "完全相同的正文", tasks: [], pinned: true,
    });
    await syncPrivateSpace(keys());
    await db.accountNotes.delete([ACCOUNT, note.id]); // fresh device
    const result = await privateSpaceRepository.restoreBackup(ACCOUNT, [original]);
    expect(result).toEqual({ added: 1, skipped: 0 });
    const restored = await privateSpaceRepository.get(ACCOUNT, note.id);
    expect(restored?.cloudVersion).toBe(0);
    expect(restored?.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
    await syncPrivateSpace(keys());
    const rows = await privateSpaceRepository.list(ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("恢复前");
    expect(rows[0].cloudVersion).toBe(1);
    expect(rows[0].syncedRevision).toBe(2);
    expect(getPrivateSpaceSyncState(ACCOUNT).conflicts).toBe(0);
  });

  it("does not overwrite divergent restored notes; preserves a genuine conflict copy", async () => {
    const note = await privateSpaceRepository.create(ACCOUNT, "note");
    const cloudNote = await privateSpaceRepository.save(ACCOUNT, note.id, {
      kind: "note", title: "云端版本", body: "来自云端", tasks: [], pinned: false,
    });
    await syncPrivateSpace(keys());
    await db.accountNotes.delete([ACCOUNT, note.id]);
    const changed = { ...cloudNote, title: "备份版本", body: "不能丢失的修改" };
    await privateSpaceRepository.restoreBackup(ACCOUNT, [changed]);
    await syncPrivateSpace(keys());
    const all = await privateSpaceRepository.list(ACCOUNT);
    expect(all).toHaveLength(2);
    expect(all.find(row => row.id === note.id)?.body).toBe("来自云端");
    expect(all.find(row => row.id !== note.id)?.body).toBe("不能丢失的修改");
    expect(getPrivateSpaceSyncState(ACCOUNT).conflicts).toBe(1);
  });

  it("skips only oversized note, uploads subsequent notes, and avoids retry storms", async () => {
    const huge = await privateSpaceRepository.create(ACCOUNT, "note");
    await privateSpaceRepository.save(ACCOUNT, huge.id, {
      kind: "note", title: "本机大笔记", body: "大".repeat(31_000), tasks: [], pinned: false,
    });
    const normal = await privateSpaceRepository.create(ACCOUNT, "note");
    await privateSpaceRepository.save(ACCOUNT, normal.id, {
      kind: "note", title: "普通笔记", body: "继续同步", tasks: [], pinned: false,
    });
    await syncPrivateSpace(keys());
    expect(cloud.has(normal.id)).toBe(true);
    expect(cloud.has(huge.id)).toBe(false);
    expect((await privateSpaceRepository.get(ACCOUNT, huge.id))?.body).toBe("大".repeat(31_000));
    expect(getPrivateSpaceSyncState(ACCOUNT)).toMatchObject({ status: "error" });
    expect(getPrivateSpaceSyncState(ACCOUNT).error).toContain("仅保存在本机");
    // No repetitive retry when the oversize content has not changed.
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(cloud.size).toBe(1);
    await privateSpaceRepository.save(ACCOUNT, huge.id, {
      kind: "note", title: "缩短后", body: "现在可以同步", tasks: [], pinned: false,
    });
    await syncPrivateSpace(keys());
    expect(cloud.has(huge.id)).toBe(true);
    expect(getPrivateSpaceSyncState(ACCOUNT).status).toBe("synced");
  });

  it("invalidates a cancelled in-flight sync so a new session can start immediately", async () => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    let unblock!: (value: Response) => void;
    let captured = false;
    vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      if (!captured && path === "/api/private-space/list") {
        captured = true;
        return new Promise<Response>(resolve => { unblock = resolve; });
      }
      return originalFetch(url, options);
    }));
    const old = syncPrivateSpace(keys());
    // Allow the first job to reach the delayed list endpoint.
    for (let i = 0; i < 30 && !captured; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(captured).toBe(true);
    cancelPrivateSpaceSync(ACCOUNT);
    const later = await syncPrivateSpace({ ...keys(), sessionGeneration: 2 });
    expect(later).toBeUndefined();
    expect(getPrivateSpaceSyncState(ACCOUNT).status).toBe("synced");
    unblock(result({ items: [], nextCursor: null }));
    await old;
    expect(getPrivateSpaceSyncState(ACCOUNT).status).toBe("synced");
  });

  it("never discards locally saved notes when offline", async () => {
    const note = await privateSpaceRepository.create(ACCOUNT, "todo");
    vi.stubGlobal("navigator", { onLine: false });
    await syncPrivateSpace(keys());
    expect(getPrivateSpaceSyncState(ACCOUNT).status).toBe("offline");
    expect(await privateSpaceRepository.get(ACCOUNT, note.id)).toBeTruthy();
    expect(cloud.size).toBe(0);
  });
});
