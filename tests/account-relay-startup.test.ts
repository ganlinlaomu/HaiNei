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

  it("restores authoritative DM read state before starting Relay history", () => {
    const source = readFileSync(join(process.cwd(), "src/stores/keys.ts"), "utf8");
    const criticalRestore = source.indexOf("fetchAndMaterializeAccountState(this, criticalStateNamespaces, { onlyNewer: false");
    const directRefresh = source.indexOf("await useDirectMessagesStore().refresh(pk)");
    const relayStart = source.indexOf("void startAccountMessageSync(this)");
    expect(criticalRestore).toBeGreaterThan(-1);
    expect(directRefresh).toBeGreaterThan(criticalRestore);
    expect(relayStart).toBeGreaterThan(directRefresh);
    expect(source).not.toContain('["direct messages", () => useDirectMessagesStore().refresh(pk)]');
  });

  it("actively restores selected relays and repairs catch-up on first connection", () => {
    const source = readFileSync(join(process.cwd(), "src/nostr/messaging/sync/MessageSyncManager.ts"), "utf8");
    expect(source).toContain("this.resumeRelays(options.relays)");
    expect(source).toContain("if (event.connected)");
    expect(source).toContain('event.reconnected ? "reconnect" : "resume"');
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
      beginUnreadHydration: vi.fn(),
      finishUnreadHydration: vi.fn(async () => undefined),
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
    vi.doMock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
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

    releaseA();
    await expect(pendingA).resolves.toBe(false);
    expect(managerStart).toHaveBeenCalledTimes(1);
    expect(registerSigner).toHaveBeenCalledTimes(1);

    stopAccountMessageSync();
    expect(managerStop).toHaveBeenCalled();
  });
});
