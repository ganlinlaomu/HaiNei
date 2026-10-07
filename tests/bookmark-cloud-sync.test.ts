import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/dexie";
import type { AccountStateKeys } from "@/services/accountStateSync";
import {
  ensureBookmarkCloudSyncState,
  flushBookmarkCloudSync,
  getBookmarkCloudSyncState,
  markBookmarkCloudDirty,
  resetBookmarkCloudSyncForTests,
} from "@/services/bookmarkCloudSync";

const ACCOUNT = "a".repeat(64);

function keys(): AccountStateKeys {
  return {
    pkHex: ACCOUNT,
    sessionGeneration: 1,
    supportsNip44: true,
    nip44Encrypt: vi.fn(async (_peer, plaintext) => plaintext),
    nip44Decrypt: vi.fn(async (_peer, ciphertext) => ciphertext),
    signEvent: vi.fn(async event => ({
      ...event,
      id: "e".repeat(64),
      pubkey: ACCOUNT,
      sig: "f".repeat(128),
    } as any)),
  };
}

beforeEach(async () => {
  resetBookmarkCloudSyncForTests();
  await db.open();
  await Promise.all([
    db.accountBookmarks.clear(),
    db.accountMeta.clear(),
    db.accountStateMirrors.clear(),
  ]);
});

afterEach(() => {
  resetBookmarkCloudSyncForTests();
  vi.unstubAllGlobals();
});

describe("bookmark local-first cloud sync", () => {
  it("baselines existing bookmarks once, then detects a later local mutation even without an explicit dirty write", async () => {
    await db.accountBookmarks.put({
      accountPubkey: ACCOUNT,
      messageId: "old",
      createdAt: 100,
      updatedAt: 100,
      deleted: false,
    });

    const initial = await ensureBookmarkCloudSyncState(ACCOUNT);
    expect(initial).toMatchObject({
      dirty: false,
      lastSyncedMutationAt: 100,
    });

    await db.accountBookmarks.put({
      accountPubkey: ACCOUNT,
      messageId: "new",
      createdAt: 200,
      updatedAt: 200,
      deleted: false,
    });

    const repaired = await ensureBookmarkCloudSyncState(ACCOUNT);
    expect(repaired.dirty).toBe(true);
    expect(repaired.revision).toBeGreaterThan(0);
    expect(repaired.lastMutationAt).toBe(200);
  });

  it("clears durable dirty state only after Account State accepts the current bookmark revision", async () => {
    await db.accountBookmarks.put({
      accountPubkey: ACCOUNT,
      messageId: "post",
      createdAt: 100,
      updatedAt: 100,
      deleted: false,
    });
    await ensureBookmarkCloudSyncState(ACCOUNT);

    await db.accountBookmarks.put({
      accountPubkey: ACCOUNT,
      messageId: "post",
      createdAt: 100,
      updatedAt: 200,
      deleted: true,
    });
    await markBookmarkCloudDirty(ACCOUNT);

    vi.stubGlobal("window", {
      location: { origin: "https://app.test" },
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challenge: "bookmark-sync",
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        namespace: "bookmarks",
        version: 1,
      }), { status: 200 })));

    await expect(flushBookmarkCloudSync(keys())).resolves.toBe(true);
    expect(await getBookmarkCloudSyncState(ACCOUNT)).toMatchObject({
      dirty: false,
      retryCount: 0,
      lastSyncedMutationAt: 200,
    });
  });

  it("keeps dirty state and schedules a persisted retry after a cloud failure", async () => {
    await db.accountBookmarks.put({
      accountPubkey: ACCOUNT,
      messageId: "post",
      createdAt: 100,
      updatedAt: 100,
      deleted: false,
    });
    await ensureBookmarkCloudSyncState(ACCOUNT);

    await db.accountBookmarks.put({
      accountPubkey: ACCOUNT,
      messageId: "post",
      createdAt: 100,
      updatedAt: 200,
      deleted: true,
    });
    await markBookmarkCloudDirty(ACCOUNT);

    const setTimeoutSpy = vi.fn(() => 1);
    vi.stubGlobal("window", {
      location: { origin: "https://app.test" },
      setTimeout: setTimeoutSpy,
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challenge: "bookmark-sync-fail",
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "temporary_failure",
      }), { status: 503 })));

    await expect(flushBookmarkCloudSync(keys())).rejects.toThrow("temporary_failure");
    expect(await getBookmarkCloudSyncState(ACCOUNT)).toMatchObject({
      dirty: true,
      retryCount: 1,
    });
    expect(setTimeoutSpy).toHaveBeenCalled();
  });
});
