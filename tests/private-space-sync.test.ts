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

  it("never discards locally saved notes when offline", async () => {
    const note = await privateSpaceRepository.create(ACCOUNT, "todo");
    vi.stubGlobal("navigator", { onLine: false });
    await syncPrivateSpace(keys());
    expect(getPrivateSpaceSyncState(ACCOUNT).status).toBe("offline");
    expect(await privateSpaceRepository.get(ACCOUNT, note.id)).toBeTruthy();
    expect(cloud.size).toBe(0);
  });
});
