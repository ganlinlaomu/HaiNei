// Review finding #1: the startup unread barrier is lifted only on sync status
// "live". These tests check (A) which real sync outcomes never report "live",
// and (B) what accountMessageSync does with those outcomes.
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { MessageSyncManager } from "@/nostr/messaging/sync/MessageSyncManager";

const ACCOUNT = "a".repeat(64);
const PEER = "c".repeat(64);
let sequence = 0;
const databases: HaiNeiDatabase[] = [];

function repository() {
  const db = new HaiNeiDatabase(`review-restore-barrier-${sequence++}`);
  databases.push(db);
  return new SyncedMessageRepository(db);
}

function manager(repo: SyncedMessageRepository, subscribe: (relays: string[], filters: any[]) => any) {
  return new MessageSyncManager({
    repository: repo,
    subscribe,
    observeRelays: () => () => undefined,
    resumeRelays: () => {},
    retryOutgoing: () => {},
    now: () => 1_900_000_000_000,
  });
}

const idleSubscription = () => ({ on() {}, unsub() {} });

afterEach(async () => {
  vi.doUnmock("@/nostr/messaging/sync");
  vi.resetModules();
  const active = databases.splice(0);
  active.forEach(item => item.close());
  await Promise.all(active.map(item => Dexie.delete(item.name)));
});

describe("review #1 (A): sync outcomes that never report live", () => {
  it("reports only offline when no message relay is configured", async () => {
    const statuses: string[] = [];
    const sync = manager(repository(), idleSubscription);
    try {
      await sync.start({
        accountPubkey: ACCOUNT, relays: [], authors: [PEER, ACCOUNT],
        decodeContext: { accountPubkey: ACCOUNT }, onStatus: status => { statuses.push(status); },
      });
      expect(statuses).toContain("offline");
      expect(statuses).not.toContain("live");
    } finally {
      sync.stop();
    }
  });

  it("reports error, not live, when the history catch-up throws", async () => {
    const statuses: string[] = [];
    // Realtime subscription works; the bounded history request throws.
    const sync = manager(repository(), (_relays, filters) => {
      if (filters.some(filter => filter.until !== undefined)) throw new Error("relay pool unavailable");
      return idleSubscription();
    });
    try {
      await sync.start({
        accountPubkey: ACCOUNT, relays: ["wss://relay.test"], authors: [PEER, ACCOUNT],
        decodeContext: { accountPubkey: ACCOUNT }, onStatus: status => { statuses.push(status); },
      });
      expect(statuses).toContain("error");
      expect(statuses).not.toContain("live");
    } finally {
      sync.stop();
    }
  });

  it("control: a normal empty catch-up does report live", async () => {
    const statuses: string[] = [];
    const sync = manager(repository(), (relays, filters) => ({
      on(name: string, callback: (...args: any[]) => void) {
        if (name === "eose" && filters.some(filter => filter.until !== undefined)) queueMicrotask(() => callback(relays[0]));
      },
      unsub() {},
    }));
    try {
      await sync.start({
        accountPubkey: ACCOUNT, relays: ["wss://relay.test"], authors: [PEER, ACCOUNT],
        decodeContext: { accountPubkey: ACCOUNT }, onStatus: status => { statuses.push(status); },
      });
      expect(statuses).toContain("live");
    } finally {
      sync.stop();
    }
  });
});

async function startWithStatus(finalStatus: "offline" | "error" | "live", relays = ["wss://relay.test"]) {
  const directMessages = {
    historyHydrationPhase: "idle",
    beginHistoryHydration: vi.fn(() => { directMessages.historyHydrationPhase = "hydrating"; }),
    finishHistoryHydration: vi.fn(async (_account: string, outcome = "live") => {
      directMessages.historyHydrationPhase = outcome;
    }),
    finishReadStateRestore: vi.fn(),
    noteFreshPersistedIncoming: vi.fn(),
    processReceipt: vi.fn(),
    acknowledgePersistedIncoming: vi.fn(async () => undefined),
  };
  const friendships: any = {
    loadedFor: ACCOUNT, authorizationReady: true, loading: false, records: [],
    getRecord: vi.fn(), isAccepted: vi.fn(() => true), load: vi.fn(async () => undefined),
  };
  const noopStore = () => ({
    processProfileMessage: vi.fn(), processTombstone: vi.fn(),
    processCanonicalInteraction: vi.fn(async () => undefined),
    addNotification: vi.fn(), resolveFriendRequests: vi.fn(), inbox: [],
  });
  vi.resetModules();
  vi.doMock("@/nostr/messaging/sync", () => ({
    MessageSyncManager: class {
      start = vi.fn(async (options: any) => {
        await options.onStatus("connecting");
        await options.onStatus("catching-up");
        await options.onStatus(finalStatus);
      });
      stop = vi.fn();
      retryDeferredAuthorization = vi.fn(async () => 0);
      resume = vi.fn(async () => undefined);
      markConversationRead = vi.fn(async () => undefined);
    },
  }));
  vi.doMock("@/nostr/relays", () => ({
    getRelaysFromStorage: () => relays,
    inspectRelays: vi.fn(() => ({})),
    onRelayConnectionState: vi.fn(() => () => undefined),
    releaseUnusedRelayConnections: vi.fn(),
  }));
  vi.doMock("@/services/dmRelayDirectory", () => ({
    selectOwnDmRelays: (relays: string[]) => relays,
    ensureOwnDmRelayList: vi.fn(async () => true),
    getOwnDmRelayStatus: vi.fn(async () => ({ relays, pending: false, attempts: 0 })),
    cancelDmRelayDirectoryWork: vi.fn(),
    logDmRelayDirectoryFailure: vi.fn(),
  }));
  vi.doMock("@/stores/friendships", () => ({ useFriendshipsStore: () => friendships, isFriendshipAcceptedAt: () => true }));
  vi.doMock("@/stores/directMessages", () => ({
    useDirectMessagesStore: () => directMessages,
    isAuthorizedCanonicalDirectMessage: () => true,
  }));
  vi.doMock("@/stores/profiles", () => ({ useProfilesStore: noopStore }));
  vi.doMock("@/stores/feedPreferences", () => ({ useFeedPreferencesStore: noopStore }));
  vi.doMock("@/stores/interactions", () => ({ useInteractionsStore: noopStore, isInteractionMessage: () => false }));
  vi.doMock("@/stores/messages", () => ({ useMessagesStore: noopStore }));
  vi.doMock("@/stores/notifications", () => ({ useNotificationsStore: noopStore }));
  vi.doMock("@/repositories/syncedMessageRepository", () => ({
    syncedMessageRepository: { getSyncState: vi.fn(async () => ({ status: "idle", relayStates: {} })) },
  }));
  vi.doMock("@/services/messageAuthorizationEvents", () => ({ onMessageAuthorizationChanged: () => () => undefined }));
  vi.doMock("@/services/pushNotifications", () => ({
    pushEnabledForAccount: () => false, syncPushAuthorizationPolicy: vi.fn(async () => false),
  }));
  vi.doMock("@/nostr/messaging/service", () => ({ registerOutgoingPushSigner: vi.fn() }));
  vi.doMock("@/nostr/messaging/homeDelivery", () => ({
    createHomeMessageHandler: () => vi.fn(async () => true),
    incomingFriendRequestNotification: () => null,
  }));

  const { startAccountMessageSync, stopAccountMessageSync } = await import("@/services/accountMessageSync");
  await startAccountMessageSync({
    pkHex: ACCOUNT, isLoggedIn: true, supportsNip44: true,
    nip44Decrypt: vi.fn(async () => ""),
    signEvent: vi.fn(async (event: any) => ({ ...event, id: "1".repeat(64), pubkey: ACCOUNT, sig: "2".repeat(128) })),
  });
  // Let any follow-up promise chains settle.
  await new Promise(resolve => setTimeout(resolve, 20));
  stopAccountMessageSync();
  return directMessages;
}

describe("review #1 (B): accountMessageSync lifts the unread barrier on terminal non-live outcomes", () => {
  it("control: the harness releases the barrier after live", async () => {
    const directMessages = await startWithStatus("live");
    expect(directMessages.finishReadStateRestore).toHaveBeenCalledWith(ACCOUNT);
  });

  it("releases the barrier when no message relay is configured (offline)", async () => {
    const directMessages = await startWithStatus("offline", []);
    expect(directMessages.historyHydrationPhase).toBe("error");
    expect(directMessages.finishReadStateRestore).toHaveBeenCalledWith(ACCOUNT);
  });

  it("keeps the barrier on a transient offline while relays are configured", async () => {
    const directMessages = await startWithStatus("offline");
    expect(directMessages.historyHydrationPhase).toBe("hydrating");
    expect(directMessages.finishReadStateRestore).not.toHaveBeenCalled();
  });

  it("releases the barrier after the sync settles as error", async () => {
    const directMessages = await startWithStatus("error");
    expect(directMessages.historyHydrationPhase).toBe("error");
    expect(directMessages.finishReadStateRestore).toHaveBeenCalledWith(ACCOUNT);
  });
});
