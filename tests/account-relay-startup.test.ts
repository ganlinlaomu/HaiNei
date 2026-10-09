import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("account relay startup ordering", () => {
  it("loads the selected account settings before warming read relays", () => {
    const source = readFileSync(join(process.cwd(), "src/stores/keys.ts"), "utf8");
    const settingsLoad = source.indexOf("await useSettingsStore().load(pk)");
    const warmup = source.indexOf("warmReadRelaysForSession(this)");
    expect(settingsLoad).toBeGreaterThan(-1);
    expect(warmup).toBeGreaterThan(settingsLoad);
  });

  it("returns from local restore without waiting for remote critical state, but gates Relay history on authoritative unread", () => {
    const source = readFileSync(join(process.cwd(), "src/stores/keys.ts"), "utf8");
    const criticalRequest = source.indexOf("fetchAndMaterializeAccountState(this, criticalStateNamespaces, { onlyNewer: false");
    const criticalNamespaces = source.indexOf('["read_state", "notification_state", "friendships"]');
    const localRefresh = source.indexOf("await directMessages.refresh(pk)");
    const pendingUnread = source.indexOf("useDirectMessagesStore().beginReadStateRestore(pk)");
    const remoteWait = source.indexOf("const criticalState = await criticalStateRestore");
    const authoritativeRefresh = source.indexOf("await directMessages.refresh(pk)", localRefresh + 1);
    const notificationRefresh = source.indexOf("await useNotificationsStore().refreshSyncedState(pk)");
    const finishUnread = source.indexOf("directMessages.finishReadStateRestore(pk)");
    const relayStart = source.indexOf("await startAccountMessageSync(this)");

    expect(criticalRequest).toBeGreaterThan(-1);
    expect(criticalNamespaces).toBeGreaterThan(-1);
    expect(localRefresh).toBeGreaterThan(criticalRequest);
    // The first refresh calculates durable local unread asynchronously.
    // The badge must be suppressed BEFORE that refresh can render.
    expect(pendingUnread).toBeGreaterThan(source.indexOf("warmReadRelaysForSession(this)"));
    expect(pendingUnread).toBeLessThan(criticalRequest);
    expect(pendingUnread).toBeLessThan(localRefresh);
    expect(remoteWait).toBeGreaterThan(localRefresh);
    expect(notificationRefresh).toBeGreaterThan(remoteWait);
    expect(notificationRefresh).toBeLessThan(authoritativeRefresh);
    expect(authoritativeRefresh).toBeGreaterThan(remoteWait);
    expect(finishUnread).toBeGreaterThan(authoritativeRefresh);
    expect(relayStart).toBeGreaterThan(finishUnread);

    const beforeNetworkPhase = source.slice(source.indexOf("// Local-first phase:"), source.indexOf("// Network phase:"));
    expect(beforeNetworkPhase).not.toContain("await criticalStateRestore");
    expect(source).not.toContain('["direct messages", () => useDirectMessagesStore().refresh(pk)]');
  });

  it("actively restores selected relays and repairs catch-up on first connection", () => {
    const source = readFileSync(join(process.cwd(), "src/nostr/messaging/sync/MessageSyncManager.ts"), "utf8");
    expect(source).toContain("this.resumeRelays(options.relays)");
    expect(source).toContain("if (event.connected)");
    expect(source).toContain('event.reconnected ? "reconnect" : "resume"');
  });

  it("keeps DM relays sticky and only reconciles after sustained connection failures", () => {
    const source = readFileSync(join(process.cwd(), "src/services/accountMessageSync.ts"), "utf8");
    expect(source).toContain("bindDmRelayHealthWatch");
    expect(source).toContain("DM_RELAY_FAILURE_THRESHOLD = 3");
    expect(source).toContain("DM_RELAY_FAILURE_GRACE_MS = 5 * 60_000");
    expect(source).toContain("onRelayConnectionState(event =>");
    expect(source).toContain("if (event.connected)");
    expect(source).toContain("clearDmRelayFailure(event.url)");
    expect(source).toContain('getRelaysFromStorage("read")');
    expect(source).toContain("replaceUnhealthyRelays: [relayUrl]");
    expect(source).toContain("getOwnDmRelayStatus(account)");
    expect(source).toContain("stopDmRelayHealthWatch()");
  });
});


describe("account message sync generation", () => {
  it("prevents a stale account startup from resurrecting Relay sync after another account starts", async () => {
    vi.resetModules();
    const accountA = "a".repeat(64);
    const accountB = "b".repeat(64);
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const managerStart = vi.fn(async (_options: any) => undefined);
    const managerStop = vi.fn();
    const registerSigner = vi.fn();
    const ensureOwnDmRelayList = vi.fn(async () => true);
    const cancelDmRelayDirectoryWork = vi.fn();

    const friendships: any = {
      loadedFor: "",
      authorizationReady: false,
      loading: false,
      records: [],
      getRecord: vi.fn(),
      isAccepted: vi.fn(() => false),
      load: vi.fn(async (account: string) => {
        if (account === accountA) await gateA;
        friendships.loadedFor = account;
        friendships.authorizationReady = true;
      }),
    };
    const directMessages = {
      beginHistoryHydration: vi.fn(),
      finishHistoryHydration: vi.fn(async () => undefined),
      processReceipt: vi.fn(),
      acknowledgePersistedIncoming: vi.fn(async () => undefined),
    };
    const noopStore = () => ({
      processProfileMessage: vi.fn(),
      processTombstone: vi.fn(),
      processCanonicalInteraction: vi.fn(async () => undefined),
      addNotification: vi.fn(),
      resolveFriendRequests: vi.fn(),
      inbox: [],
    });

    vi.doMock("@/nostr/messaging/sync", () => ({
      MessageSyncManager: class {
        start = managerStart;
        stop = managerStop;
        retryDeferredAuthorization = vi.fn(async () => 0);
        resume = vi.fn(async () => undefined);
        markConversationRead = vi.fn(async () => undefined);
      },
    }));
    vi.doMock("@/nostr/relays", () => ({
      getRelaysFromStorage: () => ["wss://relay.test"],
      inspectRelays: vi.fn(() => ({
        "wss://relay.test": { ready: true, state: "connected" },
      })),
      onRelayConnectionState: vi.fn(() => () => undefined),
      releaseUnusedRelayConnections: vi.fn(),
    }));
    vi.doMock("@/services/dmRelayDirectory", () => ({
      selectOwnDmRelays: (relays: string[]) => relays.slice(0, 2),
      ensureOwnDmRelayList,
      getOwnDmRelayStatus: vi.fn(async () => ({ relays: ["wss://relay.test"], pending: false, attempts: 0 })),
      cancelDmRelayDirectoryWork,
      logDmRelayDirectoryFailure: vi.fn(),
    }));
    vi.doMock("@/stores/friendships", () => ({
      useFriendshipsStore: () => friendships,
      isFriendshipAcceptedAt: () => false,
    }));
    vi.doMock("@/stores/directMessages", () => ({
      useDirectMessagesStore: () => directMessages,
      isAuthorizedCanonicalDirectMessage: () => false,
    }));
    vi.doMock("@/stores/profiles", () => ({ useProfilesStore: noopStore }));
    vi.doMock("@/stores/feedPreferences", () => ({ useFeedPreferencesStore: noopStore }));
    vi.doMock("@/stores/interactions", () => ({
      useInteractionsStore: noopStore,
      isInteractionMessage: () => false,
    }));
    vi.doMock("@/stores/messages", () => ({ useMessagesStore: noopStore }));
    vi.doMock("@/stores/notifications", () => ({ useNotificationsStore: noopStore }));
    vi.doMock("@/repositories/syncedMessageRepository", () => ({
      syncedMessageRepository: {
        getSyncState: vi.fn(async () => ({ status: "idle", relayStates: {} })),
      },
    }));
    vi.doMock("@/services/messageAuthorizationEvents", () => ({
      onMessageAuthorizationChanged: () => () => undefined,
    }));
    vi.doMock("@/services/pushNotifications", () => ({
      pushEnabledForAccount: () => false,
      syncPushAuthorizationPolicy: vi.fn(async () => false),
    }));
    vi.doMock("@/nostr/messaging/service", () => ({
      registerOutgoingPushSigner: registerSigner,
    }));
    vi.doMock("@/nostr/messaging/homeDelivery", () => ({
      createHomeMessageHandler: () => vi.fn(async () => true),
      incomingFriendRequestNotification: () => null,
    }));

    const { startAccountMessageSync, stopAccountMessageSync } = await import("@/services/accountMessageSync");
    const keys = (account: string) => ({
      pkHex: account,
      isLoggedIn: true,
      supportsNip44: true,
      nip44Decrypt: vi.fn(async () => "plaintext"),
      signEvent: vi.fn(async (event: any) => ({ ...event, id: "1".repeat(64), pubkey: account, sig: "2".repeat(128) })),
    });

    const pendingA = startAccountMessageSync(keys(accountA));
    await vi.waitFor(() => expect(friendships.load).toHaveBeenCalledWith(accountA));

    const startedB = startAccountMessageSync(keys(accountB));
    await expect(startedB).resolves.toBe(true);
    expect(managerStart).toHaveBeenCalledTimes(1);
    expect(managerStart.mock.calls[0][0].accountPubkey).toBe(accountB);
    expect(managerStart.mock.calls[0][0].relays).toEqual(["wss://relay.test"]);
    expect(ensureOwnDmRelayList).toHaveBeenCalledTimes(1);
    expect(ensureOwnDmRelayList.mock.calls[0][0]).toBe(accountB);

    releaseA();
    await expect(pendingA).resolves.toBe(false);
    expect(managerStart).toHaveBeenCalledTimes(1);
    expect(registerSigner).toHaveBeenCalledTimes(1);

    stopAccountMessageSync();
    expect(managerStop).toHaveBeenCalled();
    expect(cancelDmRelayDirectoryWork).toHaveBeenCalledWith(accountB);
  });
});
