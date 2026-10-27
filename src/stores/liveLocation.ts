import { defineStore } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import {
  decodeLiveLocationControl,
  liveLocationControlTags,
  newLiveLocationId,
  serializeLiveLocationControl,
  serializeLocationShare,
  type LocationShare,
} from "@/nostr/messaging/locationShare";
import { sendFastControl } from "@/nostr/messaging/service";
import { getRelaysFromStorage } from "@/nostr/relays";
import { DEFAULT_RELAY_URLS } from "@/services/connectionSettings";
import { onBeforeAccountLock } from "@/services/accountLifecycle";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { useKeyStore } from "@/stores/keys";
import { debugLog } from "@/utils/debugLog";

/** Send an update after this much movement, or this long without one. */
export const LIVE_MOVE_METRES = 20;
export const LIVE_HEARTBEAT_MS = 30_000;
/** A receiver calls a share stale when the last update is older than this. */
export const LIVE_STALE_SECONDS = 120;
// Relays may drop an update after this; the receiver only needs the latest.
const UPDATE_WRAP_TTL_SECONDS = 10 * 60;
const CLOCK_MS = 15_000;
const STOP_ON_LOCK_TIMEOUT_MS = 1_500;

export type OutgoingLiveShare = {
  account: string;
  peer: string;
  id: string;
  expiresAt: number;
  seq: number;
  last: LocationShare;
  lastSentAt: number;
};

export type IncomingLiveShare = {
  peer: string;
  id: string;
  expiresAt: number;
  seq: number;
  location?: LocationShare;
  receivedAt: number;
  stopped: boolean;
};

export type LiveShareStatus =
  | { state: "live" | "stale"; location: LocationShare; remainingSeconds: number; ageSeconds: number }
  | { state: "ended" };

/** Great-circle distance in metres. */
export function distanceMetres(a: Pick<LocationShare, "lat" | "lng">, b: Pick<LocationShare, "lat" | "lng">) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
let watchId: number | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let visibilityListener: (() => void) | null = null;
/** Live cards on screen keep the clock running even before any update arrives. */
let clockHolds = 0;
/** Newest GPS fix while sharing; a heartbeat sends this, not the last sent one. */
let latestFix: LocationShare | null = null;

/**
 * Live location sharing for the signed-in account. Not tied to a page, so a
 * share keeps running while the user moves between chats. Updates exist only
 * in memory on both sides; the opening card is the one stored message.
 */
export const useLiveLocationStore = defineStore("liveLocation", {
  state: () => ({
    /** Our active shares, by peer. */
    outgoing: {} as Record<string, OutgoingLiveShare>,
    /** Shares received from friends, by share id. */
    incoming: {} as Record<string, IncomingLiveShare>,
    /** Wall clock for "剩余 N 分钟", ticking only while a share exists. */
    now: Date.now(),
  }),
  getters: {
    activeOutgoing: state => Object.values(state.outgoing),
  },
  actions: {
    outgoingFor(peer: string) {
      return this.outgoing[peer.toLowerCase()];
    },
    /**
     * What a card for share `id` from `peer` should show right now. Until the
     * first update arrives, the opening card itself is the latest position
     * (the sender's first update can be up to 30 s later).
     */
    incomingStatus(id: string, peer: string, opening?: LocationShare): LiveShareStatus {
      const share = this.incoming[id];
      const now = Math.floor(this.now / 1000);
      if (share && (share.peer !== peer.toLowerCase() || share.stopped)) return { state: "ended" };
      const location = share?.location ?? (opening?.live?.id === id ? opening : undefined);
      const expiresAt = share?.expiresAt ?? opening?.live?.expiresAt ?? 0;
      if (!location || expiresAt <= now) return { state: "ended" };
      const ageSeconds = Math.max(0, now - location.at);
      return {
        state: ageSeconds > LIVE_STALE_SECONDS ? "stale" : "live",
        location,
        remainingSeconds: expiresAt - now,
        ageSeconds,
      };
    },

    async startSharing(peerPubkey: string, durationSeconds: number, first: LocationShare) {
      const keys = useKeyStore();
      const account = keys.pkHex.toLowerCase();
      const peer = peerPubkey.toLowerCase();
      if (!account || !keys.supportsNip44 || peer === account) throw new Error("当前账号无法共享位置");
      installLiveLocationLockHook();
      if (this.outgoing[peer]) await this.stopSharing(peer);
      const id = newLiveLocationId();
      const at = nowSeconds();
      const expiresAt = at + durationSeconds;
      const opening = { ...first, at, live: { id, expiresAt } };
      // The opening card is an ordinary durable DM (queued, retried, pushed).
      useDirectMessagesStore().send(peer, serializeLocationShare(opening), undefined, undefined, undefined, { preserveDraft: true });
      this.outgoing[peer] = { account, peer, id, expiresAt, seq: 0, last: opening, lastSentAt: Date.now() };
      this.startRuntime();
      debugLog("system", "live_location_started", { durationSeconds }, "info");
    },

    async stopSharing(peerPubkey: string, notify = true) {
      const peer = peerPubkey.toLowerCase();
      const share = this.outgoing[peer];
      if (!share) return;
      delete this.outgoing[peer];
      this.stopRuntimeIfIdle();
      if (!notify || share.expiresAt <= nowSeconds()) return;
      await this.sendControl(share, serializeLiveLocationControl({ kind: "stop", id: share.id, at: nowSeconds() }),
        Math.max(60, share.expiresAt - nowSeconds() + 300));
    },

    /** Apply a received update or stop. Our own devices' copies are ignored. */
    receiveControl(message: CanonicalMessage) {
      const account = useKeyStore().pkHex.toLowerCase();
      const peer = message.senderPubkey.toLowerCase();
      if (!account || peer === account) return;
      const control = decodeLiveLocationControl(message);
      if (!control) return;
      installLiveLocationLockHook();
      const existing = this.incoming[control.id];
      // A share id belongs to whoever sent it first; nobody else can move it.
      if (existing && existing.peer !== peer) return;
      if (control.kind === "stop") {
        this.incoming[control.id] = existing
          ? { ...existing, stopped: true }
          : { peer, id: control.id, expiresAt: control.at + 3600, seq: Number.MAX_SAFE_INTEGER, receivedAt: Date.now(), stopped: true };
        debugLog("system", "live_location_stopped", {}, "info");
        return;
      }
      if (control.expiresAt <= nowSeconds()) return;
      if (existing && (existing.stopped || control.seq <= existing.seq)) return;
      this.incoming[control.id] = {
        peer, id: control.id, expiresAt: control.expiresAt, seq: control.seq,
        location: control.location, receivedAt: Date.now(), stopped: false,
      };
      debugLog("system", "live_location_received", { seq: control.seq, ageSeconds: Math.max(0, nowSeconds() - control.location.at) }, "info");
      this.startClock();
    },

    async sendControl(share: OutgoingLiveShare, content: string, wrapTtlSeconds: number) {
      const keys = useKeyStore();
      if (keys.pkHex.toLowerCase() !== share.account) return false;
      try {
        await sendFastControl({
          recipientPubkeys: [share.peer],
          content,
          tags: liveLocationControlTags(),
          // Like call signals: the built-in relays are the channel both sides
          // always share, plus ours, so a friend with other relays still gets it.
          relays: [...new Set([...DEFAULT_RELAY_URLS, ...getRelaysFromStorage("write")])],
          wrapTtlSeconds,
          context: {
            senderPubkey: share.account,
            nip44Encrypt: keys.nip44Encrypt.bind(keys),
            signEvent: keys.signEvent.bind(keys),
          },
        });
        return true;
      } catch (error) {
        // Best effort: the next update supersedes a lost one.
        debugLog("system", "live_location_send_failed", { reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" }, "warn");
        return false;
      }
    },

    async sendUpdate(share: OutgoingLiveShare, location: LocationShare) {
      const current = this.outgoing[share.peer];
      if (!current || current.id !== share.id) return;
      const seq = current.seq + 1;
      const moved = Math.round(distanceMetres(current.last, location));
      this.outgoing[share.peer] = { ...current, seq, last: location, lastSentAt: Date.now() };
      if (await this.sendControl(current, serializeLiveLocationControl({ kind: "update", id: current.id, expiresAt: current.expiresAt, seq, location }), UPDATE_WRAP_TTL_SECONDS)) {
        // Sequence and distance only: never coordinates in diagnostics.
        debugLog("system", "live_location_sent", { seq, moved }, "info");
      }
    },

    /** A new GPS fix: send it to every share it moved far enough for. */
    onPosition(position: GeolocationPosition) {
      const location: LocationShare = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        ...(Number.isFinite(position.coords.accuracy) ? { accuracy: position.coords.accuracy } : {}),
        at: nowSeconds(),
      };
      latestFix = location;
      for (const share of Object.values(this.outgoing)) {
        if (distanceMetres(share.last, location) >= LIVE_MOVE_METRES || Date.now() - share.lastSentAt >= LIVE_HEARTBEAT_MS) {
          void this.sendUpdate(share, location);
        }
      }
    },

    /** Clock tick: end expired shares and keep a quiet share visibly alive. */
    tick(force = false) {
      this.now = Date.now();
      const now = nowSeconds();
      for (const share of Object.values(this.outgoing)) {
        if (share.expiresAt <= now) void this.stopSharing(share.peer, false);
        else if (force || Date.now() - share.lastSentAt >= LIVE_HEARTBEAT_MS) {
          // The newest fix (small moves under the distance threshold add up),
          // stamped now: the timestamp also says "still sharing".
          void this.sendUpdate(share, { ...(latestFix ?? share.last), at: now });
        }
      }
      for (const [id, share] of Object.entries(this.incoming)) {
        if (share.expiresAt + 3600 < now) delete this.incoming[id];
      }
      this.stopRuntimeIfIdle();
    },

    /** A visible live card: keep "剩余 N 分钟" and staleness current. Returns the release. */
    holdClock() {
      clockHolds += 1;
      this.startClock();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        clockHolds = Math.max(0, clockHolds - 1);
        this.stopRuntimeIfIdle();
      };
    },
    startClock() {
      if (clock) return;
      this.now = Date.now();
      clock = setInterval(() => this.tick(), CLOCK_MS);
    },
    startRuntime() {
      this.startClock();
      if (watchId === null && typeof navigator !== "undefined" && navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(
          position => this.onPosition(position),
          () => undefined,
          { enableHighAccuracy: true, maximumAge: 10_000 },
        );
      }
      if (!visibilityListener && typeof document !== "undefined") {
        // iOS suspends a backgrounded web app: send a fresh fix on return.
        visibilityListener = () => { if (!document.hidden) this.tick(true); };
        document.addEventListener("visibilitychange", visibilityListener);
      }
    },
    stopRuntimeIfIdle() {
      if (Object.keys(this.outgoing).length) return;
      if (watchId !== null && typeof navigator !== "undefined") navigator.geolocation?.clearWatch(watchId);
      watchId = null;
      latestFix = null;
      if (visibilityListener && typeof document !== "undefined") document.removeEventListener("visibilitychange", visibilityListener);
      visibilityListener = null;
      if (!Object.keys(this.incoming).length && !clockHolds && clock) {
        clearInterval(clock);
        clock = null;
      }
    },

    /** Lock, account switch or logout: tell peers we stopped, forget everything. */
    async stopAllForLock(account: string) {
      const shares = Object.values(this.outgoing).filter(share => share.account === account);
      await Promise.race([
        Promise.all(shares.map(share => this.stopSharing(share.peer))),
        new Promise(resolve => setTimeout(resolve, STOP_ON_LOCK_TIMEOUT_MS)),
      ]);
      this.outgoing = {};
      this.incoming = {};
      this.stopRuntimeIfIdle();
    },
  },
});

let lockHookInstalled = false;
/** Called once the store is first used with an active Pinia. */
export function installLiveLocationLockHook() {
  if (lockHookInstalled) return;
  lockHookInstalled = true;
  onBeforeAccountLock(account => useLiveLocationStore().stopAllForLock(account.toLowerCase()));
}
