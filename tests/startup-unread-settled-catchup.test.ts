// The startup unread count is final only after bounded history has settled.
// "live" means the realtime subscription is up; catch-up may still be
// "pending" (a Relay page or continuation is outstanding).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountMessageSyncSnapshot } from "@/services/accountMessageSync";

const ACCOUNT = "a".repeat(64);
const PEER = "c".repeat(64);

type Message = { id: string; createdAt: number };
type CatchupRun = { durable: Message[]; catchup: "pending" | "settled" };

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("@/nostr/messaging/sync");
  vi.resetModules();
});

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function isAfter(message: Message, cursor: Message | undefined) {
  if (!cursor) return true;
  return message.createdAt > cursor.createdAt || (message.createdAt === cursor.createdAt && message.id > cursor.id);
}

/**
 * Device B restores the cloud read cursor written by device A, then receives
 * history in catch-up runs. The store mock recomputes unread from durable
 * history exactly when accountMessageSync finalizes startup hydration.
 */
async function restoreOnSecondDevice(readCursor: Message, runs: CatchupRun[]) {
  const durable: Message[] = [];
  const directMessages = {
    historyHydrationPhase: "idle",
    visibleUnread: null as number | null,
    pendingUnread: 0,
    beginHistoryHydration: vi.fn(() => { directMessages.historyHydrationPhase = "hydrating"; }),
    finishHistoryHydration: vi.fn(async (_account: string, outcome = "live") => {
      if (directMessages.historyHydrationPhase !== "hydrating") return;
      directMessages.pendingUnread = durable.filter(message => isAfter(message, readCursor)).length;
      directMessages.historyHydrationPhase = outcome;
    }),
    finishReadStateRestore: vi.fn(() => {
      directMessages.visibleUnread = directMessages.pendingUnread;
    }),
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
  let managerOptions: any;
  const runCatchup = async (run: CatchupRun) => {
    await managerOptions.onStatus("catching-up");
    for (const message of run.durable) if (!durable.some(item => item.id === message.id)) durable.push(message);
    managerOptions.onCatchupStatus(run.catchup);
    await managerOptions.onStatus("live");
    await flushMicrotasks();
  };

  vi.resetModules();
  vi.doMock("@/nostr/messaging/sync", () => ({
    MessageSyncManager: class {
      start = vi.fn(async (options: any) => {
        managerOptions = options;
        await options.onStatus("connecting");
      });
      stop = vi.fn();
      retryDeferredAuthorization = vi.fn(async () => 0);
      resume = vi.fn(async () => undefined);
      markConversationRead = vi.fn(async () => undefined);
    },
  }));
  vi.doMock("@/nostr/relays", () => ({
    getRelaysFromStorage: () => ["wss://x.test", "wss://y.test"],
    inspectRelays: vi.fn(() => ({})),
    onRelayConnectionState: vi.fn(() => () => undefined),
    releaseUnusedRelayConnections: vi.fn(),
  }));
  vi.doMock("@/services/dmRelayDirectory", () => ({
    selectOwnDmRelays: (relays: string[]) => relays,
    ensureOwnDmRelayList: vi.fn(async () => true),
    getOwnDmRelayStatus: vi.fn(async () => ({ relays: ["wss://x.test", "wss://y.test"], pending: false, attempts: 0 })),
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

  const sync = await import("@/services/accountMessageSync");
  await sync.startAccountMessageSync({
    pkHex: ACCOUNT, isLoggedIn: true, supportsNip44: true,
    nip44Decrypt: vi.fn(async () => ""),
    signEvent: vi.fn(async (event: any) => ({ ...event, id: "1".repeat(64), pubkey: ACCOUNT, sig: "2".repeat(128) })),
  });
  const visibleAfterRun: Array<number | null> = [];
  const phases: string[] = [];
  for (const run of runs) {
    await runCatchup(run);
    visibleAfterRun.push(directMessages.visibleUnread);
    phases.push(sync.messageSyncPhase(sync.getAccountMessageSyncStatus(), directMessages.historyHydrationPhase === "hydrating"));
  }
  return { sync, directMessages, visibleAfterRun, phases, runCatchup };
}

// Device A has read through m3; m4 arrived later and is unread on device A.
const m1 = { id: "1".repeat(64), createdAt: 100 };
const m2 = { id: "2".repeat(64), createdAt: 200 };
const m3 = { id: "3".repeat(64), createdAt: 300 };
const m4 = { id: "4".repeat(64), createdAt: 400 };
const deviceAUnread = [m1, m2, m3, m4].filter(message => isAfter(message, m3)).length;

describe("startup unread waits for settled catch-up", () => {
  it("matches the other device's unread count once history settles, never the partial count", async () => {
    expect(deviceAUnread).toBe(1);
    // Relay x answers first (m1..m3); Relay y with m4 is still pending.
    const { sync, visibleAfterRun, phases } = await restoreOnSecondDevice(m3, [
      { durable: [m1, m2, m3], catchup: "pending" },
      { durable: [m4], catchup: "settled" },
    ]);
    try {
      // While pending the count stays hidden instead of showing a wrong 0.
      expect(visibleAfterRun[0]).toBeNull();
      expect(phases[0]).toBe("syncing");
      expect(visibleAfterRun[1]).toBe(deviceAUnread);
      expect(phases[1]).toBe("idle");
    } finally {
      sync.stopAccountMessageSync();
    }
  });

  it("finalizes immediately when the first catch-up already settled", async () => {
    const { sync, visibleAfterRun } = await restoreOnSecondDevice(m3, [
      { durable: [m1, m2, m3, m4], catchup: "settled" },
    ]);
    try {
      expect(visibleAfterRun[0]).toBe(deviceAUnread);
    } finally {
      sync.stopAccountMessageSync();
    }
  });

  it("falls back to the durable projection if catch-up stays pending past the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { sync, directMessages, visibleAfterRun } = await restoreOnSecondDevice(m3, [
      { durable: [m1, m2, m3, m4], catchup: "pending" },
    ]);
    try {
      expect(visibleAfterRun[0]).toBeNull();
      await vi.advanceTimersByTimeAsync(sync.STARTUP_UNREAD_PENDING_GRACE_MS);
      expect(directMessages.visibleUnread).toBe(deviceAUnread);
    } finally {
      sync.stopAccountMessageSync();
    }
  });
});

describe("conversation list sync phase", async () => {
  const { messageSyncPhase } = await import("@/services/accountMessageSync");
  const snapshot = (patch: Partial<AccountMessageSyncSnapshot>): AccountMessageSyncSnapshot => ({
    accountPubkey: ACCOUNT, status: "live", relay: "connected", live: "active", catchup: "settled", ...patch,
  });

  it("maps sync state to 连接中 / 同步中 / 空闲", () => {
    expect(messageSyncPhase(snapshot({ status: "connecting", relay: "connecting" }), true)).toBe("connecting");
    expect(messageSyncPhase(snapshot({ status: "offline", relay: "offline" }), false)).toBe("connecting");
    expect(messageSyncPhase(snapshot({ status: "catching-up", catchup: "running" }), false)).toBe("syncing");
    expect(messageSyncPhase(snapshot({ catchup: "pending" }), true)).toBe("syncing");
    // After startup, a background continuation does not keep the title busy.
    expect(messageSyncPhase(snapshot({ catchup: "pending" }), false)).toBe("idle");
    expect(messageSyncPhase(snapshot({}), false)).toBe("idle");
    // A slow secondary relay paging after the managed relay caught up is
    // background work: the title no longer says 同步中 for seconds.
    expect(messageSyncPhase(snapshot({ status: "catching-up", catchup: "running", preferredCaughtUp: true }), false)).toBe("idle");
    expect(messageSyncPhase(snapshot({ status: "catching-up", catchup: "running", preferredCaughtUp: false }), false)).toBe("syncing");
  });

  it("marks the managed relay caught up per pass and debounces the title", async () => {
    const { readFileSync } = await import("node:fs");
    const sync = readFileSync("src/services/accountMessageSync.ts", "utf8");
    expect(sync).toContain("setAccountMessageSyncStatus(account, accountSyncSnapshot.status, { preferredCaughtUp: true })");
    expect(sync).toContain('...(status === "catching-up" ? { preferredCaughtUp: false } : {})');
    const view = readFileSync("src/views/Conversations.vue", "utf8");
    expect(view).toContain("const SYNC_LABEL_DELAY_MS = 700;");
  });

  it("shows the phase next to the 私信 title", async () => {
    const { readFileSync } = await import("node:fs");
    const view = readFileSync("src/views/Conversations.vue", "utf8");
    expect(view).toContain('<h1 class="primary-page-title">私信</h1>\n        <span v-if="syncLabel" class="sync-label"');
    expect(view).toContain('phase === "connecting" ? "连接中…" : phase === "syncing" ? "同步中…" : ""');
  });
});
