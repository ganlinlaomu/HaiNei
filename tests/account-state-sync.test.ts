import "fake-indexeddb/auto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, type FriendshipRecord } from "@/db/dexie";
import {
  fetchAndMaterializeAccountState,
  materializeAccountState,
  mergeFriendshipSnapshots,
  mergeNamespaceData,
  syncAccountStateNamespace,
  type AccountStateEnvelope,
  type AccountStateKeys,
} from "@/services/accountStateSync";
import {
  reconcileForegroundFriendState,
  resetForegroundFriendStateSyncForTests,
} from "@/services/foregroundFriendStateSync";
import { useFriendshipsStore } from "@/stores/friendships";
import { useFriendsStore } from "@/stores/friends";
import { canStartDirectMessage } from "@/nostr/messaging/directMessages";
import { deviceStorage } from "@/services/deviceStorage";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
const PEER = "c".repeat(64);

function friendship(state: FriendshipRecord["state"], at: number, id: string): FriendshipRecord {
  return {
    accountPubkey: ACCOUNT, peerPubkey: PEER, state,
    lastAction: state === "accepted" ? "accept" : "remove",
    lastControlAt: at, lastControlEventId: id, updatedAt: at * 1000,
  };
}

function envelope(namespace: AccountStateEnvelope["namespace"], data: unknown): string {
  return JSON.stringify({ schemaVersion: 1, namespace, updatedAt: 10, data });
}

function keys(): AccountStateKeys {
  return {
    pkHex: ACCOUNT,
    supportsNip44: true,
    nip44Encrypt: vi.fn(async (_peer, plaintext) => plaintext),
    nip44Decrypt: vi.fn(async (_peer, ciphertext) => ciphertext),
    signEvent: vi.fn(async event => ({ ...event, id: "e".repeat(64), pubkey: ACCOUNT, sig: "f".repeat(128) } as any)),
  };
}

beforeEach(async () => {
  resetForegroundFriendStateSyncForTests();
  await db.open();
  await Promise.all([
    db.accountFriendships.clear(), db.accountFriends.clear(), db.accountProfiles.clear(),
    db.accountBookmarks.clear(), db.conversationReadStates.clear(), db.accountMeta.clear(),
    db.accountStateMirrors.clear(), db.outgoingQueue.clear(), db.outgoingDmTasks.clear(),
  ]);
  setActivePinia(createPinia());
});

afterEach(() => vi.unstubAllGlobals());

describe("encrypted account-state materialization", () => {
  it("restores accepted friendship before Relay history and Friends does not require legacy metadata", async () => {
    vi.stubGlobal("window", { location: { origin: "https://app.test" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ challenge: "challenge", expiresAt: 100 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ snapshots: [{
        namespace: "friendships", version: 3, ciphertext: envelope("friendships", [friendship("accepted", 20, "accept")]), updatedAt: 20,
      }] }), { status: 200 })));

    await fetchAndMaterializeAccountState(keys(), ["friendships"]);
    await useFriendshipsStore().load(ACCOUNT);
    await useFriendsStore().load(ACCOUNT);
    expect(useFriendshipsStore().isAccepted(PEER)).toBe(true);
    expect(useFriendsStore().sortedList.map(item => item.pubkey)).toEqual([PEER]);
    expect(canStartDirectMessage(ACCOUNT, PEER, useFriendshipsStore().isAccepted)).toBe(true);
  });

  it("reconciles only changed friend namespaces on foreground and refreshes live stores", async () => {
    await materializeAccountState(ACCOUNT, "friendships", [friendship("accepted", 20, "accept-old")], 1);
    await materializeAccountState(ACCOUNT, "friend_metadata", [{
      accountPubkey: ACCOUNT,
      pubkey: PEER,
      name: "旧备注",
      groups: ["同学"],
      updatedAt: 100,
    }], 1);
    await useFriendshipsStore().load(ACCOUNT);
    await useFriendsStore().load(ACCOUNT);

    const requestBodies: any[] = [];
    vi.stubGlobal("window", { location: { origin: "https://app.test" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/api/auth/challenge") {
        return new Response(JSON.stringify({ challenge: "foreground", expiresAt: Math.floor(Date.now() / 1000) + 60 }), { status: 201 });
      }
      const body = JSON.parse(String(init?.body || "{}"));
      requestBodies.push(body);
      return new Response(JSON.stringify({ snapshots: [
        {
          namespace: "friendships",
          version: 2,
          ciphertext: envelope("friendships", [friendship("removed", 30, "remove-new")]),
          updatedAt: 30,
        },
        {
          namespace: "friend_metadata",
          version: 2,
          ciphertext: envelope("friend_metadata", [{
            accountPubkey: ACCOUNT,
            pubkey: PEER,
            name: "新备注",
            groups: ["家人"],
            updatedAt: 200,
          }]),
          updatedAt: 30,
        },
      ] }), { status: 200 });
    }));

    const restored = await reconcileForegroundFriendState(keys(), { force: true, now: 100_000 });
    expect(restored.sort()).toEqual(["friend_metadata", "friendships"]);
    expect(requestBodies[0].knownVersions).toEqual({ friendships: 1, friend_metadata: 1 });
    expect(useFriendshipsStore().getState(PEER)).toBe("removed");
    expect(useFriendsStore().list.find(item => item.pubkey === PEER)).toMatchObject({
      name: "新备注",
      groups: ["家人"],
    });

    const callsAfterFirstCheck = vi.mocked(fetch).mock.calls.length;
    await reconcileForegroundFriendState(keys(), { now: 100_001 });
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterFirstCheck);
  });

  it("never lets a stale snapshot resurrect a newer Relay removal", () => {
    const merged = mergeFriendshipSnapshots(
      [friendship("removed", 30, "remove-new")],
      [friendship("accepted", 20, "accept-old")],
    );
    expect(merged[0].state).toBe("removed");
  });

  it("purges retired system relays from encrypted settings restored from account state", async () => {
    const restored = mergeNamespaceData("settings", null, {
      relays: [
        { url: "wss://relay.mostr.pub", read: true, write: true, enabled: true, source: "default", addedAt: 0, updatedAt: 0 },
        { url: "wss://user.example", read: true, write: true, enabled: true, source: "user", addedAt: 1, updatedAt: 1 },
      ],
      mediaServers: [],
    });
    expect(restored.relays.some((relay: any) => relay.url === "wss://relay.mostr.pub")).toBe(false);
    expect(restored.relays.some((relay: any) => relay.url === "wss://relay.damus.io")).toBe(false);
    expect(restored.relays.some((relay: any) => relay.url === "wss://nostr.dzo-hadar.ts.net" && relay.source === "default")).toBe(true);

    await materializeAccountState(ACCOUNT, "settings", {
      relays: [{ url: "wss://relay.mostr.pub", read: true, write: true, enabled: true, source: "default", addedAt: 0, updatedAt: 0 }],
      mediaServers: [],
    }, 7);
    const stored = JSON.parse(deviceStorage.getItem(`nostr_settings_${ACCOUNT}`) || "{}");
    expect(stored.settings.relays.some((relay: any) => relay.url === "wss://relay.mostr.pub")).toBe(false);
    expect(stored.settings.relays.some((relay: any) => relay.url === "wss://relay.damus.io")).toBe(false);
    expect(stored.settings.relays.some((relay: any) => relay.url === "wss://nostr.dzo-hadar.ts.net")).toBe(true);
    expect((await db.accountStateMirrors.get([ACCOUNT, "settings"]))?.data).toEqual(stored.settings);
  });

  it("keeps the newest read-receipt privacy choice across devices", () => {
    const merged = mergeNamespaceData("settings", {
      relays: [], mediaServers: [],
      privacy: { readReceipts: false, updatedAt: 20, updatedBy: "phone" },
    }, {
      relays: [], mediaServers: [],
      privacy: { readReceipts: true, updatedAt: 10, updatedBy: "tablet" },
    });
    expect(merged.privacy.readReceipts).toBe(false);

    const newerRemote = mergeNamespaceData("settings", merged, {
      relays: [], mediaServers: [],
      privacy: { readReceipts: true, updatedAt: 30, updatedBy: "tablet" },
    });
    expect(newerRemote.privacy.readReceipts).toBe(true);
  });

  it("keeps newer local friend metadata when a stale D1 snapshot is restored", async () => {
    await db.accountFriends.put({
      accountPubkey: ACCOUNT,
      pubkey: PEER,
      name: "本机新备注",
      groups: ["家人"],
      updatedAt: 200,
    });

    await materializeAccountState(ACCOUNT, "friend_metadata", [{
      accountPubkey: ACCOUNT,
      pubkey: PEER,
      name: "D1旧备注",
      groups: ["旧分组"],
      updatedAt: 100,
    }], 7);

    expect(await db.accountFriends.get([ACCOUNT, PEER])).toMatchObject({
      name: "本机新备注",
      groups: ["家人"],
      updatedAt: 200,
    });
    expect((await db.accountStateMirrors.get([ACCOUNT, "friend_metadata"]))?.data).toEqual([
      expect.objectContaining({
        pubkey: PEER,
        name: "本机新备注",
        groups: ["家人"],
        updatedAt: 200,
      })
    ]);
  });

  it("restores own profile, bookmarks, and cross-device DM read cursor with account isolation", async () => {
    await materializeAccountState(ACCOUNT, "own_profile", { ownerPubkey: ACCOUNT, nickname: "海内", updatedAt: 5 }, 1);
    await materializeAccountState(ACCOUNT, "bookmarks", [{ accountPubkey: ACCOUNT, messageId: "post-1", createdAt: 5, updatedAt: 5 }], 1);
    await materializeAccountState(ACCOUNT, "read_state", [{ conversationId: `conversation:${PEER}`, lastReadCreatedAt: 9, lastReadMessageId: "m9", updatedAt: 9 }], 1);
    expect((await db.accountProfiles.get([ACCOUNT, ACCOUNT]))?.nickname).toBe("海内");
    expect(await db.accountBookmarks.get([ACCOUNT, "post-1"])).toBeTruthy();
    expect((await db.conversationReadStates.get([ACCOUNT, `conversation:${PEER}`]))?.lastReadMessageId).toBe("m9");
    expect(await db.accountProfiles.where("accountPubkey").equals(OTHER).count()).toBe(0);
  });

  it("merges a 409 conflict instead of overwriting another device bookmark", async () => {
    await db.accountBookmarks.put({ accountPubkey: ACCOUNT, messageId: "local", createdAt: 2, updatedAt: 2 });
    await db.accountStateMirrors.put({ accountPubkey: ACCOUNT, namespace: "bookmarks", version: 1, data: [], updatedAt: 1 });
    const requests: Array<{ path: string; body: any }> = [];
    let challenge = 0;
    vi.stubGlobal("window", { location: { origin: "https://app.test" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/api/auth/challenge") return new Response(JSON.stringify({ challenge: `c${++challenge}`, expiresAt: 100 }), { status: 201 });
      const body = JSON.parse(String(init?.body || "{}"));
      requests.push({ path, body });
      if (path.endsWith("/put") && requests.filter(item => item.path.endsWith("/put")).length === 1) {
        return new Response(JSON.stringify({ error: "account_state_conflict", currentVersion: 2 }), { status: 409 });
      }
      if (path.endsWith("/get")) return new Response(JSON.stringify({ snapshots: [{
        namespace: "bookmarks", version: 2,
        ciphertext: envelope("bookmarks", [{ accountPubkey: ACCOUNT, messageId: "remote", createdAt: 3, updatedAt: 3 }]), updatedAt: 3,
      }] }), { status: 200 });
      return new Response(JSON.stringify({ namespace: "bookmarks", version: 3 }), { status: 200 });
    }));

    await expect(syncAccountStateNamespace(keys(), "bookmarks", "device-a")).resolves.toBe(true);
    const finalPut = requests.filter(item => item.path.endsWith("/put")).at(-1)!.body;
    expect(finalPut.expectedVersion).toBe(2);
    const finalData = JSON.parse(finalPut.ciphertext).data;
    expect(finalData.map((item: any) => item.messageId).sort()).toEqual(["local", "remote"]);
  });

  it("never includes posts, DM bodies, or outgoing work in account snapshot namespaces", async () => {
    const source = readFileSync(join(process.cwd(), "src/services/accountStateSync.ts"), "utf8");
    expect(source).not.toMatch(/syncedMessages|outgoingQueue|outgoingDmTasks|accountMessages/);
  });

  it("contains no direct production localStorage access outside the migration boundary", () => {
    const hits: string[] = [];
    const root = join(process.cwd(), "src");
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/localStorage\.(?:getItem|setItem|removeItem)/.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
