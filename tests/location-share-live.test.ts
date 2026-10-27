// Live location sharing: the opening card is a stored DM; updates and the
// stop signal are expiring, never-stored controls kept only in memory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { finalizeEvent, getPublicKey, utils, type EventTemplate } from "nostr-tools";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

const mocks = vi.hoisted(() => ({
  sendFastControl: vi.fn(async (_options: any) => ({})),
  dmSend: vi.fn(),
  lockHooks: [] as Array<(account: string) => unknown>,
  keys: { pkHex: "a".repeat(64), supportsNip44: true, nip44Encrypt: vi.fn(), signEvent: vi.fn() },
}));
vi.mock("@/nostr/messaging/service", () => ({ sendFastControl: mocks.sendFastControl }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/stores/directMessages", () => ({ useDirectMessagesStore: () => ({ send: mocks.dmSend }) }));
vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.keys }));
vi.mock("@/services/accountLifecycle", () => ({ onBeforeAccountLock: (hook: any) => { mocks.lockHooks.push(hook); return () => {}; } }));

import {
  decodeLiveLocationControl,
  LIVE_LOCATION_CONTROL_TYPE,
  liveLocationControlTags,
  parseLocationShare,
  serializeLiveLocationControl,
  serializeLocationShare,
} from "@/nostr/messaging/locationShare";
import { classifyPrivateMessage } from "@/nostr/messaging/messageRouting";
import { createHomeMessageHandler } from "@/nostr/messaging/homeDelivery";
import { decodeMessageEvent, encryptDirectMessage, decryptDirectMessage, nip17Adapter } from "@/nostr/messaging/protocol";
import { distanceMetres, LIVE_STALE_SECONDS, useLiveLocationStore } from "@/stores/liveLocation";
import DmLocationCard from "@/components/DmLocationCard.vue";
import { DEFAULT_RELAY_URLS } from "@/services/connectionSettings";
import LocationShareSheet from "@/components/LocationShareSheet.vue";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const ID = "c".repeat(32);
const now = () => Math.floor(Date.now() / 1000);
const update = (seq: number, lat = 31.2, expiresAt = now() + 900, sender = PEER) => ({
  id: `m${seq}`, senderPubkey: sender, recipientPubkeys: [ACCOUNT], createdAt: now(), tags: liveLocationControlTags(),
  plaintext: serializeLiveLocationControl({ kind: "update", id: ID, expiresAt, seq, location: { lat, lng: 121.4, accuracy: 10, at: now() } }),
}) as any;
const stop = (sender = PEER) => ({
  id: "stop", senderPubkey: sender, recipientPubkeys: [ACCOUNT], createdAt: now(), tags: liveLocationControlTags(),
  plaintext: serializeLiveLocationControl({ kind: "stop", id: ID, at: now() }),
}) as any;

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.sendFastControl.mockClear();
  mocks.dmSend.mockClear();
  mocks.keys.pkHex = ACCOUNT;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("live location payloads", () => {
  it("bounds the opening card's share to the longest offered duration", () => {
    const at = 1_793_000_000;
    const card = (expiresAt: number, id = ID) => JSON.stringify({ type: "hainei-location", lat: 1, lng: 2, at, live: { id, expiresAt } });
    expect(parseLocationShare(card(at + 900))?.live).toEqual({ id: ID, expiresAt: at + 900 });
    expect(parseLocationShare(card(at + 3600 + 60))?.live).toBeTruthy();
    expect(parseLocationShare(card(at + 3600 + 61))).toBeNull();
    expect(parseLocationShare(card(at))).toBeNull();
    expect(parseLocationShare(card(at + 900, "xyz"))).toBeNull();
  });

  it("round-trips update and stop controls, and never treats untagged JSON as one", () => {
    const message = update(3);
    expect(decodeLiveLocationControl(message)).toMatchObject({ kind: "update", id: ID, seq: 3, location: { lat: 31.2, lng: 121.4, accuracy: 10 } });
    expect(decodeLiveLocationControl(stop())).toMatchObject({ kind: "stop", id: ID });
    expect(decodeLiveLocationControl({ ...message, tags: [] })).toBeNull();
    expect(JSON.parse(message.plaintext).type).toBe(LIVE_LOCATION_CONTROL_TYPE);
  });

  it("routes tagged controls away from chat and storage", async () => {
    expect(classifyPrivateMessage({ tags: liveLocationControlTags(), plaintext: "{}", createdAt: now() })).toBe("control");
    const processLiveLocation = vi.fn();
    const mirrorMessage = vi.fn();
    const handler = createHomeMessageHandler({
      accountPubkey: ACCOUNT, currentAccount: () => ACCOUNT, isAcceptedMessage: () => true,
      isInteraction: () => false, processInteraction: () => {}, mirrorMessage, processLiveLocation,
    });
    // false = discard: the ingestion pipeline does not persist the message.
    await expect(handler(update(1), { source: "realtime" } as any)).resolves.toBe(false);
    expect(processLiveLocation).toHaveBeenCalledOnce();
    expect(mirrorMessage).not.toHaveBeenCalled();
  });

  it("wraps controls with a NIP-40 expiration that the receiver still accepts", async () => {
    const senderSecret = utils.hexToBytes("1".padStart(64, "0"));
    const recipientSecret = utils.hexToBytes("2".padStart(64, "0"));
    const recipient = getPublicKey(recipientSecret);
    const encoded = await nip17Adapter.encode!({ recipientPubkeys: [recipient], plaintext: "x", tags: liveLocationControlTags(), wrapTtlSeconds: 600 }, {
      senderPubkey: getPublicKey(senderSecret),
      nip44Encrypt: (pubkey: string, plaintext: string) => encryptDirectMessage({ senderPrivateKey: senderSecret, recipientPubkey: pubkey, plaintext }),
      signEvent: (event: EventTemplate) => Promise.resolve(finalizeEvent(event, senderSecret)),
    });
    for (const wrap of encoded.events) {
      const expiration = Number(wrap.tags.find(tag => tag[0] === "expiration")?.[1]);
      expect(expiration).toBeGreaterThanOrEqual(now() + 599);
      expect(expiration).toBeLessThanOrEqual(now() + 600);
    }
    const wrap = encoded.events.find(event => event.tags.some(tag => tag[0] === "p" && tag[1] === recipient))!;
    await expect(decodeMessageEvent(wrap, {
      accountPubkey: recipient,
      nip44Decrypt: (pubkey: string, ciphertext: string) => decryptDirectMessage({ recipientPrivateKey: recipientSecret, senderPubkey: pubkey, ciphertext }),
    })).resolves.toBeTruthy();
    const plain = await nip17Adapter.encode!({ recipientPubkeys: [recipient], plaintext: "y" }, {
      senderPubkey: getPublicKey(senderSecret),
      nip44Encrypt: (pubkey: string, plaintext: string) => encryptDirectMessage({ senderPrivateKey: senderSecret, recipientPubkey: pubkey, plaintext }),
      signEvent: (event: EventTemplate) => Promise.resolve(finalizeEvent(event, senderSecret)),
    });
    expect(plain.events.every(event => !event.tags.some(tag => tag[0] === "expiration"))).toBe(true);
  });
});

describe("receiving a live share", () => {
  it("treats the opening card as the position until an update arrives, then follows updates", () => {
    vi.useFakeTimers();
    const store = useLiveLocationStore();
    store.now = Date.now();
    const opening = { lat: 31.2, lng: 121.4, at: now(), live: { id: ID, expiresAt: now() + 900 } };
    expect(store.incomingStatus(ID, PEER, opening)).toMatchObject({ state: "live", location: { lat: 31.2 } });
    vi.advanceTimersByTime((LIVE_STALE_SECONDS + 5) * 1000);
    store.now = Date.now();
    // No update at all: "stale" (the sender may be in the background), never "ended".
    expect(store.incomingStatus(ID, PEER, opening).state).toBe("stale");
    store.receiveControl(update(1, 31.3, opening.live.expiresAt));
    expect(store.incomingStatus(ID, PEER, opening)).toMatchObject({ state: "live", location: { lat: 31.3 } });
    vi.advanceTimersByTime(901_000);
    store.now = Date.now();
    expect(store.incomingStatus(ID, PEER, opening).state).toBe("ended");
  });

  it("keeps the clock running for a visible card even with no update yet", () => {
    const store = useLiveLocationStore();
    // The clock is module state: clear one an earlier test left on real timers.
    store.stopRuntimeIfIdle();
    vi.useFakeTimers();
    const release = store.holdClock();
    const before = store.now;
    vi.advanceTimersByTime(31_000);
    expect(store.now).toBeGreaterThan(before);
    release();
    const stopped = store.now;
    vi.advanceTimersByTime(31_000);
    expect(store.now).toBe(stopped);
  });

  it("keeps the newest update, ignores replays, other senders and our own copies", () => {
    const store = useLiveLocationStore();
    store.receiveControl(update(2, 31.2));
    store.receiveControl(update(1, 80));
    store.receiveControl(update(3, 50, now() + 900, "d".repeat(64)));
    store.receiveControl(update(4, 60, now() + 900, ACCOUNT));
    expect(store.incoming[ID]).toMatchObject({ seq: 2, peer: PEER, location: { lat: 31.2 } });
    expect(store.incomingStatus(ID, PEER)).toMatchObject({ state: "live" });
    expect(store.incomingStatus(ID, "d".repeat(64))).toEqual({ state: "ended" });
  });

  it("goes stale without updates, ends at expiry, and stays ended after a stop", () => {
    vi.useFakeTimers();
    const store = useLiveLocationStore();
    store.receiveControl(update(1, 31.2, now() + 900));
    vi.advanceTimersByTime((LIVE_STALE_SECONDS + 5) * 1000);
    store.now = Date.now();
    expect(store.incomingStatus(ID, PEER).state).toBe("stale");
    vi.advanceTimersByTime(900 * 1000);
    store.now = Date.now();
    expect(store.incomingStatus(ID, PEER).state).toBe("ended");

    const fresh = useLiveLocationStore();
    fresh.incoming = {};
    fresh.receiveControl(update(1, 31.2, now() + 900));
    fresh.receiveControl(stop());
    fresh.receiveControl(update(9, 40, now() + 900));
    expect(fresh.incomingStatus(ID, PEER)).toEqual({ state: "ended" });
  });
});

describe("sharing our location", () => {
  const fix = (lat: number) => ({ coords: { latitude: lat, longitude: 121.4, accuracy: 10 } }) as GeolocationPosition;

  it("opens with a stored card, then sends expiring updates only after 20 m or 30 s", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { geolocation: { watchPosition: vi.fn(() => 7), clearWatch: vi.fn() } });
    const store = useLiveLocationStore();
    await store.startSharing(PEER, 900, { lat: 31.2, lng: 121.4, accuracy: 10, at: now() });
    expect(mocks.dmSend).toHaveBeenCalledOnce();
    const card = parseLocationShare(mocks.dmSend.mock.calls[0][1]);
    expect(card?.live?.expiresAt).toBe(now() + 900);
    expect(mocks.dmSend.mock.calls[0][5]).toEqual({ preserveDraft: true });

    store.onPosition(fix(31.20005));
    expect(mocks.sendFastControl).not.toHaveBeenCalled();
    store.onPosition(fix(31.2003));
    expect(mocks.sendFastControl).toHaveBeenCalledOnce();
    const sent = mocks.sendFastControl.mock.calls[0][0];
    expect(sent.wrapTtlSeconds).toBe(600);
    // The built-in relays both sides share, plus our own write relays.
    expect(sent.relays).toEqual(expect.arrayContaining(["wss://relay.test", ...DEFAULT_RELAY_URLS]));
    expect(sent.tags).toEqual(liveLocationControlTags());
    expect(decodeLiveLocationControl({ tags: sent.tags, plaintext: sent.content })).toMatchObject({ kind: "update", seq: 1 });

    vi.advanceTimersByTime(31_000);
    store.tick();
    expect(mocks.sendFastControl).toHaveBeenCalledTimes(2);
    expect(distanceMetres({ lat: 31.2, lng: 121.4 }, { lat: 31.2003, lng: 121.4 })).toBeGreaterThan(30);
  });

  it("stops by itself at expiry and tells the peer when stopped early or on lock", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { geolocation: { watchPosition: vi.fn(() => 7), clearWatch: vi.fn() } });
    const store = useLiveLocationStore();
    await store.startSharing(PEER, 900, { lat: 31.2, lng: 121.4, at: now() });
    vi.advanceTimersByTime(901_000);
    store.tick();
    expect(store.outgoingFor(PEER)).toBeUndefined();

    await store.startSharing(PEER, 900, { lat: 31.2, lng: 121.4, at: now() });
    mocks.sendFastControl.mockClear();
    await store.stopSharing(PEER);
    expect(decodeLiveLocationControl({ tags: liveLocationControlTags(), plaintext: mocks.sendFastControl.mock.calls[0][0].content })?.kind).toBe("stop");

    await store.startSharing(PEER, 3600, { lat: 31.2, lng: 121.4, at: now() });
    store.receiveControl(update(1));
    mocks.sendFastControl.mockClear();
    await Promise.all(mocks.lockHooks.map(hook => hook(ACCOUNT)));
    expect(mocks.sendFastControl).toHaveBeenCalledOnce();
    expect(store.activeOutgoing).toEqual([]);
    expect(store.incoming).toEqual({});
  });
});

describe("live location UI", () => {
  const render = (component: any, props: Record<string, unknown>, setup?: (store: ReturnType<typeof useLiveLocationStore>) => void) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    setup?.(useLiveLocationStore());
    const app = createSSRApp({ render: () => h(component, props) });
    app.use(pinia);
    return renderToString(app);
  };
  const card = (expiresAt = now() + 900) => ({ lat: 31.2, lng: 121.4, at: now(), live: { id: ID, expiresAt } });

  it("shows a friend's latest position, or that the share ended", async () => {
    const live = await render(DmLocationCard, { location: card(), own: false, peer: PEER }, store => store.receiveControl(update(1, 31.25)));
    expect(live).toContain("实时位置");
    expect(live).toContain("31.25000, 121.40000");
    expect(live).toMatch(/更新于 刚刚 · 剩余 15 分钟/);
    const ended = await render(DmLocationCard, { location: card(now() - 1), own: false, peer: PEER });
    expect(ended).toContain("位置共享已结束");
    expect(ended).not.toContain("31.20000");
    const stopped = await render(DmLocationCard, { location: card(), own: false, peer: PEER }, store => store.receiveControl(stop()));
    expect(stopped).toContain("位置共享已结束");
  });

  it("shows the opening card as live before the first update arrives (it used to say ended)", async () => {
    const html = await render(DmLocationCard, { location: { ...card(), at: now() }, own: false, peer: PEER });
    expect(html).toContain("实时位置");
    expect(html).not.toContain("位置共享已结束");
    expect(html).toContain("31.20000, 121.40000");
    expect(html).toMatch(/更新于 刚刚 · 剩余 15 分钟/);
  });

  it("offers to stop our own running share", async () => {
    vi.stubGlobal("navigator", { geolocation: { watchPosition: vi.fn(() => 7), clearWatch: vi.fn() } });
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useLiveLocationStore();
    await store.startSharing(PEER, 900, { lat: 31.2, lng: 121.4, at: now() });
    const id = store.outgoingFor(PEER)!.id;
    const app = createSSRApp({ render: () => h(DmLocationCard, { location: { ...card(), live: { id, expiresAt: now() + 900 } }, own: true, peer: PEER }) });
    app.use(pinia);
    const html = await renderToString(app);
    expect(html).toContain("我的实时位置");
    expect(html).toContain("共享中 · 剩余 15 分钟");
    expect(html).toContain("停止共享");
    await store.stopSharing(PEER, false);
  });

  it("is reachable from the chat and the conversation list", () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
    expect(read("src/views/Messages.vue")).toContain("await liveLocation.startSharing(peerPubkey.value, durationSeconds, location)");
    expect(read("src/views/Conversations.vue")).toContain('<LiveLocationBanner :name-of="displayName" />');
    expect(read("src/components/LocationShareSheet.vue")).toContain("共享 15 分钟");
    expect(read("src/components/LocationShareSheet.vue")).toContain("共享 1 小时");
    // An omitted Boolean prop is false in Vue: without this default the chat
    // (which does not pass it) showed only "send once" (caught in Chromium).
    expect(read("src/components/LocationShareSheet.vue")).toContain("{ canShareLive: true }");
    expect(read("src/services/accountMessageSync.ts")).toContain("useLiveLocationStore().receiveControl(message)");
    void LocationShareSheet;
  });
});
