// Diagnostics for review item #8: duplicate NIP-17 re-delivery counting.
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliveryStatsLogData, getDeliveryStats, recordPersistedDelivery, resetDeliveryStats } from "@/services/dmDeliveryStats";

const ACCOUNT = "a".repeat(64);
const PEER = "c".repeat(64);

describe("dm delivery stats", () => {
  it("separates inserts from duplicates per source and excludes local replay from relay totals", () => {
    resetDeliveryStats(1_000);
    recordPersistedDelivery("realtime", true, 5, true);
    recordPersistedDelivery("realtime", false, 2.4, false);
    recordPersistedDelivery("realtime", false, 3.4, true);
    recordPersistedDelivery("history", false, 1, false);
    recordPersistedDelivery("local-migration", false, 50, true);

    const stats = getDeliveryStats();
    expect(stats.bySource.realtime).toEqual({ inserted: 1, duplicate: 2, duplicateMs: 6, duplicateChangedInbox: 1 });
    expect(stats.bySource["local-migration"]?.duplicate).toBe(1);
    expect(stats.relay).toEqual({ inserted: 1, duplicate: 3, duplicateMs: 7, duplicateChangedInbox: 1 });
    expect(deliveryStatsLogData()).toMatchObject({ relayDuplicate: 3, realtimeDuplicate: 2, historyDuplicate: 1, "local-migrationDuplicate": 1 });

    resetDeliveryStats(2_000);
    expect(getDeliveryStats()).toMatchObject({ sessionStartedAt: 2_000, bySource: {}, relay: { duplicate: 0 } });
  });
});

describe("accountMessageSync records persisted deliveries", () => {
  afterEach(() => {
    vi.doUnmock("@/nostr/messaging/sync");
    vi.resetModules();
  });

  it("counts duplicates, their inbox effect, and logs a summary when sync goes live", async () => {
    vi.resetModules();
    const messages = { inboxRevision: 0, inbox: [] as unknown[], addInbox: vi.fn() };
    const debugLog = vi.fn();
    let options: any;
    vi.doMock("@/nostr/messaging/sync", () => ({
      MessageSyncManager: class {
        start = vi.fn(async (value: any) => { options = value; });
        stop = vi.fn();
        retryDeferredAuthorization = vi.fn(async () => 0);
        resume = vi.fn(async () => undefined);
        markConversationRead = vi.fn(async () => undefined);
      },
    }));
    vi.doMock("@/utils/debugLog", () => ({ debugLog }));
    vi.doMock("@/nostr/relays", () => ({
      getRelaysFromStorage: () => ["wss://relay.test"],
      inspectRelays: vi.fn(() => ({})),
      onRelayConnectionState: vi.fn(() => () => undefined),
      releaseUnusedRelayConnections: vi.fn(),
    }));
    vi.doMock("@/services/dmRelayDirectory", () => ({
      selectOwnDmRelays: (relays: string[]) => relays,
      ensureOwnDmRelayList: vi.fn(async () => true),
      getOwnDmRelayStatus: vi.fn(async () => ({ relays: ["wss://relay.test"], pending: false, attempts: 0 })),
      cancelDmRelayDirectoryWork: vi.fn(),
      logDmRelayDirectoryFailure: vi.fn(),
    }));
    const friendships: any = { loadedFor: ACCOUNT, authorizationReady: true, loading: false, records: [], getRecord: vi.fn(), isAccepted: () => true, load: vi.fn() };
    vi.doMock("@/stores/friendships", () => ({ useFriendshipsStore: () => friendships, isFriendshipAcceptedAt: () => true }));
    const directMessages = {
      historyHydrationPhase: "idle",
      beginHistoryHydration: vi.fn(),
      finishHistoryHydration: vi.fn(async () => undefined),
      finishReadStateRestore: vi.fn(),
      noteFreshPersistedIncoming: vi.fn(),
      processReceipt: vi.fn(),
      acknowledgePersistedIncoming: vi.fn(async () => undefined),
    };
    vi.doMock("@/stores/directMessages", () => ({ useDirectMessagesStore: () => directMessages, isAuthorizedCanonicalDirectMessage: () => true }));
    const noop = () => ({ processProfileMessage: vi.fn(), processTombstone: vi.fn(), processCanonicalInteraction: vi.fn(), addNotification: vi.fn(), resolveFriendRequests: vi.fn() });
    vi.doMock("@/stores/profiles", () => ({ useProfilesStore: noop }));
    vi.doMock("@/stores/feedPreferences", () => ({ useFeedPreferencesStore: noop }));
    vi.doMock("@/stores/interactions", () => ({ useInteractionsStore: noop, isInteractionMessage: () => false }));
    vi.doMock("@/stores/messages", () => ({ useMessagesStore: () => messages }));
    vi.doMock("@/stores/notifications", () => ({ useNotificationsStore: noop }));
    vi.doMock("@/repositories/syncedMessageRepository", () => ({
      syncedMessageRepository: { getSyncState: vi.fn(async () => ({ status: "idle", relayStates: {} })) },
    }));
    vi.doMock("@/services/messageAuthorizationEvents", () => ({ onMessageAuthorizationChanged: () => () => undefined }));
    vi.doMock("@/services/pushNotifications", () => ({ pushEnabledForAccount: () => false, syncPushAuthorizationPolicy: vi.fn() }));
    vi.doMock("@/nostr/messaging/service", () => ({ registerOutgoingPushSigner: vi.fn() }));
    // The mirror for this message changes the inbox only when asked to.
    vi.doMock("@/nostr/messaging/homeDelivery", () => ({
      createHomeMessageHandler: () => vi.fn(async (message: any) => {
        if (message.plaintext === "mutates") messages.inboxRevision++;
        return true;
      }),
      incomingFriendRequestNotification: () => null,
    }));

    const { startAccountMessageSync, stopAccountMessageSync } = await import("@/services/accountMessageSync");
    const stats = await import("@/services/dmDeliveryStats");
    stats.recordPersistedDelivery("realtime", false, 1, false); // previous session leftovers
    await startAccountMessageSync({
      pkHex: ACCOUNT, isLoggedIn: true, supportsNip44: true,
      nip44Decrypt: vi.fn(async () => ""),
      signEvent: vi.fn(async (event: any) => ({ ...event, id: "1".repeat(64), pubkey: ACCOUNT, sig: "2".repeat(128) })),
    });
    const message = (plaintext: string) => ({
      id: "9".repeat(64), senderPubkey: PEER, recipientPubkeys: [ACCOUNT], conversationId: "c", plaintext,
      createdAt: 1, protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]],
    });
    await options.onPersistedMessage(message("new"), { source: "realtime" }, true);
    await options.onPersistedMessage(message("same"), { source: "realtime" }, false);
    await options.onPersistedMessage(message("mutates"), { source: "history" }, false);
    await options.onPersistedMessage(message("local"), { source: "local-migration" }, false);

    const snapshot = stats.getDeliveryStats();
    expect(snapshot.bySource.realtime).toMatchObject({ inserted: 1, duplicate: 1, duplicateChangedInbox: 0 });
    expect(snapshot.bySource.history).toMatchObject({ inserted: 0, duplicate: 1, duplicateChangedInbox: 1 });
    expect(snapshot.relay).toMatchObject({ inserted: 1, duplicate: 2, duplicateChangedInbox: 1 });
    expect(snapshot.bySource["local-migration"]?.duplicate).toBe(1);

    options.onStatus("live");
    expect(debugLog).toHaveBeenCalledWith("sync", "dm_delivery_stats", expect.objectContaining({ relayDuplicate: 2, relayInserted: 1 }), "info");
    stopAccountMessageSync();
  });
});
