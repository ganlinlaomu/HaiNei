// WebSocket-based minimal Nostr relay adapter (cleaned up, with debug toggle and reconnect)
// Exports:
// - DEFAULT_RELAYS
// - getRelaysFromStorage()
// - subscribe(relays, filtersArray)
// - publish(relays, event)
// - inspectRelays(): relay status summary
// - reconnectRelay(url): force reconnect of one relay
import { logger } from "@/utils/logger";
import { debugLog } from "@/utils/debugLog";
import {
  ACTIVE_RELAY_CONFIGS_KEY,
  DEFAULT_RELAY_URLS,
  normalizeRelayUrl,
  type RelayConfig
} from "@/services/connectionSettings";
import { performanceCounters } from "@/services/nostrCache";
import { deviceStorage } from "@/services/deviceStorage";
import { getManagedRelaySessionForUrl, managedRelayUrlFromCache } from "@/services/relaySession";

type RelayConn = {
  url: string;
  ws: WebSocket | null;
  ready: boolean;
  queue: string[];
  subs: Map<string, {
    filters: any[];
    handlers: Set<(evt: any, relayUrl: string) => void>;
    eoseHandlers: Set<(relayUrl: string) => void>;
    failureHandlers: Set<(relayUrl: string, reason: RelaySubscriptionFailureReason) => void>;
    settled: boolean;
    eoseTimer?: ReturnType<typeof setTimeout>;
  }>;
  okHandlers: Map<string, (res: any) => void>;
  reconnectTimer?: number | null;
  connectTimer?: number | null;
  sessionRefreshTimer?: number | null;
  connecting: boolean;
  generation: number;
  reconnectAttempts: number;
  hasConnected: boolean;
  connectedAt: number;
  shouldReconnect: boolean;
  disposing: boolean;
  connectStartedAt: number;
  activePublishes: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleSince: number | null;
  idleExpiresAt: number | null;
  retryAt: number | null;
  pendingCloseReason: "timeout" | "session-refresh" | null;
  lastDisconnectReason: "closed" | "timeout" | "session-refresh" | "manual" | "settings" | "idle-ttl" | null;
  connect: () => void;
};

const CONNECT_TIMEOUT = 4000;
const CONNECTION_OPEN_TIMEOUT = 10_000;
const PUBLISH_TIMEOUT = 5000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 60_000;
const RECONNECT_STABLE_MS = 30_000;
const EOSE_TIMEOUT = 8_000;
// Only preconnected/temporary sockets without subscribers or pending sends
// expire. Active NIP-17 receive points have no TTL and remain connected.
export const IDLE_RELAY_TTL_MS = 20_000;

const relaysMap: Record<string, RelayConn> = {};
let idleConnectionsReleased = 0;
export type RelaySubscriptionFailureReason = "timeout" | "closed" | "disconnected";

export type RelayConnectionEvent = {
  url: string;
  connected: boolean;
  reconnected: boolean;
  failed: boolean;
  at: number;
  latency?: number;
};
export type RelayRuntimeState = "connected" | "connecting" | "waiting-retry" | "disconnected";
export type RelayRuntimeStatus = {
  ready: boolean;
  state: RelayRuntimeState;
  queueLength: number;
  subs: number;
  okHandlers: number;
  reconnectAttempts: number;
  connectStartedAt: number;
  usage: "subscription" | "publishing" | "idle";
  pendingPublishes: number;
  idleSince: number | null;
  idleExpiresAt: number | null;
  retryAt: number | null;
  lastDisconnectReason: RelayConn["lastDisconnectReason"];
};
const connectionListeners = new Set<(event: RelayConnectionEvent) => void>();

export function onRelayConnectionState(listener: (event: RelayConnectionEvent) => void) {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

function emitConnectionState(event: RelayConnectionEvent) {
  for (const listener of connectionListeners) {
    try { listener(event); } catch (e) { logger.warn("[relay] connection listener failed", e); }
  }
}

/** A connection may only be reclaimed after EVERY consumer has released it. */
function hasRelayDemand(conn: RelayConn) {
  return conn.subs.size > 0 || conn.activePublishes > 0 || conn.okHandlers.size > 0;
}

function cancelRelayIdleTimer(conn: RelayConn) {
  if (conn.idleTimer !== null) clearTimeout(conn.idleTimer);
  conn.idleTimer = null;
  conn.idleSince = null;
  conn.idleExpiresAt = null;
}

function failRelayAcknowledgements(conn: RelayConn, reason: string) {
  // Never discard an OK callback without resolving the associated publisher.
  // The outgoing outbox may safely retry after an explicit negative outcome.
  const pending = [...conn.okHandlers.values()];
  conn.okHandlers.clear();
  conn.queue = conn.queue.filter(frame => {
    try { return JSON.parse(frame)?.[0] !== "EVENT"; } catch { return true; }
  });
  for (const confirm of pending) {
    try { confirm({ ok: false, msg: reason }); } catch (error) { logger.warn("[relay] publish failure handler failed", error); }
  }
}

function releaseRelayConnection(conn: RelayConn, reason: "idle-ttl" | "settings" | "manual") {
  if (relaysMap[conn.url] !== conn || conn.disposing) return false;
  if (reason === "idle-ttl" && hasRelayDemand(conn)) return false;
  // A failure callback can synchronously unsubscribe its own REQ. Prevent
  // nested release from disposing this socket twice or emitting stale state.
  conn.disposing = true;
  conn.lastDisconnectReason = reason;
  conn.shouldReconnect = false;
  conn.generation++;
  cancelRelayIdleTimer(conn);
  if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer);
  if (conn.connectTimer !== null) clearTimeout(conn.connectTimer);
  if (conn.sessionRefreshTimer !== null) clearTimeout(conn.sessionRefreshTimer);
  conn.reconnectTimer = null;
  conn.retryAt = null;
  conn.connectTimer = null;
  conn.sessionRefreshTimer = null;
  conn.connecting = false;
  for (const subId of conn.subs.keys()) {
    settleSubscription(conn, subId, "failure", "disconnected");
    const timer = conn.subs.get(subId)?.eoseTimer;
    if (timer) clearTimeout(timer);
  }
  conn.subs.clear();
  failRelayAcknowledgements(conn, reason);
  const wasReady = conn.ready;
  const socket = conn.ws;
  conn.ws = null;
  conn.ready = false;
  conn.queue = [];
  delete relaysMap[conn.url];
  try { socket?.close(); } catch {}
  if (reason === "idle-ttl") idleConnectionsReleased++;
  // Explicit teardown must also wake publishers waiting on a socket that
  // never reached OPEN; do not make account switches wait for the 4s timeout.
  if (wasReady || reason !== "idle-ttl") {
    emitConnectionState({ url: conn.url, connected: false, reconnected: conn.hasConnected, failed: false, at: Date.now() });
  }
  debugLog("relay", "relay_released", { relay: conn.url, reason }, "info");
  return true;
}

function updateRelayIdleLease(conn: RelayConn) {
  if (relaysMap[conn.url] !== conn || conn.disposing) return;
  if (hasRelayDemand(conn)) {
    cancelRelayIdleTimer(conn);
    return;
  }
  if (conn.idleTimer !== null) return;
  conn.idleSince = Date.now();
  conn.idleExpiresAt = conn.idleSince + IDLE_RELAY_TTL_MS;
  conn.idleTimer = setTimeout(() => {
    conn.idleTimer = null;
    if (!hasRelayDemand(conn)) releaseRelayConnection(conn, "idle-ttl");
    else cancelRelayIdleTimer(conn);
  }, IDLE_RELAY_TTL_MS);
  (conn.idleTimer as any).unref?.();
}

function renewRelayIdleLease(conn: RelayConn) {
  if (!hasRelayDemand(conn)) cancelRelayIdleTimer(conn);
  updateRelayIdleLease(conn);
}

/** Release account-independent warm/discovery sockets after session teardown.
 * A retained realtime subscription or in-flight publish always wins. */
export function releaseUnusedRelayConnections() {
  for (const conn of Object.values(relaysMap)) {
    if (!hasRelayDemand(conn)) releaseRelayConnection(conn, "manual");
  }
}


function settleSubscription(
  conn: RelayConn,
  subId: string,
  outcome: "eose" | "failure",
  reason?: RelaySubscriptionFailureReason,
) {
  const sub = conn.subs.get(subId);
  if (!sub || sub.settled) return false;
  sub.settled = true;
  if (sub.eoseTimer) clearTimeout(sub.eoseTimer);
  sub.eoseTimer = undefined;
  if (outcome === "eose") {
    for (const handler of sub.eoseHandlers) {
      try { handler(conn.url); } catch (error) { logger.warn("eose handler error", error); }
    }
  } else if (reason) {
    for (const handler of sub.failureHandlers) {
      try { handler(conn.url, reason); } catch (error) { logger.warn("subscription failure handler error", error); }
    }
  }
  return true;
}

function queuedSubscriptionIds(queue: string[]): Set<string> {
  const ids = new Set<string>();
  for (const message of queue) {
    try {
      const payload = JSON.parse(message);
      if (Array.isArray(payload) && payload[0] === "REQ" && typeof payload[1] === "string") {
        ids.add(payload[1]);
      }
    } catch {
      // Non-JSON queue entries are ignored and still flushed normally.
    }
  }
  return ids;
}

function subscriptionDiagnostic(conn: RelayConn, subId: string, filters?: any[]) {
  const activeFilters = filters ?? conn.subs.get(subId)?.filters ?? [];
  const kinds = [...new Set(activeFilters.flatMap((filter) => Array.isArray(filter?.kinds) ? filter.kinds : []))];
  const recipient = activeFilters
    .flatMap((filter) => Array.isArray(filter?.["#p"]) ? filter["#p"] : [])
    .find((value) => typeof value === "string");
  return {
    relay: conn.url,
    subId,
    kinds,
    recipientPrefix: typeof recipient === "string" ? recipient.slice(0, 12) : undefined
  };
}

function eventDiagnostic(conn: RelayConn, event: any) {
  const target = Array.isArray(event?.tags)
    ? event.tags.find((tag: unknown) => Array.isArray(tag) && tag[0] === "p")?.[1]
    : undefined;
  return {
    relay: conn.url,
    eventId: typeof event?.id === "string" ? event.id.slice(0, 12) : "unknown",
    kind: event?.kind,
    target: typeof target === "string" ? target.slice(0, 12) : undefined
  };
}

function logWireSend(conn: RelayConn, serialized: string) {
  try {
    const payload = JSON.parse(serialized);
    if (payload?.[0] === "REQ") {
      debugLog("subscription", "subscription_sent", subscriptionDiagnostic(conn, payload[1], payload.slice(2)));
    } else if (payload?.[0] === "EVENT") {
      debugLog("publish", "publish_event_sent", eventDiagnostic(conn, payload[1]));
    }
  } catch {
    // The wire send already succeeded; diagnostics must not interfere.
  }
}

function replaySubscriptions(conn: RelayConn, ws: WebSocket, queuedReqIds: Set<string>) {
  for (const [subId, sub] of conn.subs.entries()) {
    // A subscription created while disconnected already has its REQ in the queue.
    if (queuedReqIds.has(subId)) continue;
    try {
      sub.settled = false;
      if (sub.eoseTimer) clearTimeout(sub.eoseTimer);
      sub.eoseTimer = setTimeout(() => {
        settleSubscription(conn, subId, "failure", "timeout");
      }, EOSE_TIMEOUT);
      ws.send(JSON.stringify(["REQ", subId, ...sub.filters]));
      debugLog("subscription", "subscription_replayed", subscriptionDiagnostic(conn, subId, sub.filters), "info");
      debugLog("subscription", "subscription_sent", subscriptionDiagnostic(conn, subId, sub.filters));
      logger.info(`[relay] replay subscription relay=${conn.url} sub=${subId}`);
    } catch (e) {
      const request = JSON.stringify(["REQ", subId, ...sub.filters]);
      if (!conn.queue.includes(request)) conn.queue.push(request);
      logger.warn(`[relay] subscription replay failed relay=${conn.url} sub=${subId}`, e);
    }
  }
}

export const DEFAULT_RELAYS = [
  ...DEFAULT_RELAY_URLS
];

export function getRelaysFromStorage(mode: "read" | "write" | "both" = "both") {
  try {
    const structuredRaw = deviceStorage.getItem(ACTIVE_RELAY_CONFIGS_KEY);
    if (structuredRaw !== null) {
      const structured = JSON.parse(structuredRaw) as RelayConfig[];
      if (!Array.isArray(structured)) throw new Error("invalid relay configuration mirror");
      const matching = structured.filter(relay =>
        relay.enabled !== false
        && !relay.deleted
        && (mode === "both" ? relay.read || relay.write : relay[mode])
      );
      return [...new Set(matching.map(relay => normalizeRelayUrl(relay.url)).filter(Boolean))];
    }
    const raw = deviceStorage.getItem("custom-relays");
    if (raw) return [...new Set(raw.split(/\r?\n/).map(normalizeRelayUrl).filter(Boolean))];
  } catch {
    // Defaults keep startup and offline restore usable when a mirror is corrupt.
  }
  return DEFAULT_RELAYS.slice();
}

function ensureRelayConn(url: string): RelayConn {
  url = normalizeRelayUrl(url);
  if (!url) throw new Error("invalid relay URL");
  if (relaysMap[url]) return relaysMap[url];

  const conn: RelayConn = {
    url,
    ws: null,
    ready: false,
    queue: [],
    subs: new Map(),
    okHandlers: new Map(),
    reconnectTimer: null,
    connectTimer: null,
    sessionRefreshTimer: null,
    connecting: false,
    generation: 0,
    reconnectAttempts: 0,
    activePublishes: 0,
    idleTimer: null,
    idleSince: null,
    idleExpiresAt: null,
    retryAt: null,
    pendingCloseReason: null,
    lastDisconnectReason: null,
    hasConnected: false,
    connectedAt: 0,
    shouldReconnect: true,
    disposing: false,
    connectStartedAt: Date.now(),
    connect: () => undefined
  };
  relaysMap[url] = conn;

  const scheduleReconnect = (create: () => void) => {
    if (!conn.shouldReconnect || !hasRelayDemand(conn)) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
    const attempt = conn.reconnectAttempts++;
    const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6));
    const jitteredDelay = Math.min(RECONNECT_CAP_MS, Math.round(delay * (0.75 + Math.random() * 0.5)));
    conn.retryAt = Date.now() + jitteredDelay;
    debugLog("relay", "relay_reconnect_scheduled", {
      relay: url,
      reconnectAttempts: conn.reconnectAttempts,
      delayMs: jitteredDelay
    }, "warn");
    conn.reconnectTimer = window.setTimeout(() => {
      conn.reconnectTimer = null;
      conn.retryAt = null;
      if (!hasRelayDemand(conn) || relaysMap[url] !== conn) return;
      performanceCounters.relayReconnectCount++;
      create();
    }, jitteredDelay);
  };

  const create = async () => {
    if (!conn.shouldReconnect) return;
    if (conn.connecting || conn.ws?.readyState === 0 || conn.ws?.readyState === 1) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    conn.connecting = true;
    const generation = ++conn.generation;
    debugLog("relay", "relay_connecting", { relay: url, reconnectAttempts: conn.reconnectAttempts }, "info");
    try {
      const managedSession = managedRelayUrlFromCache() === url
        ? await getManagedRelaySessionForUrl(url)
        : null;
      if (generation !== conn.generation || !conn.shouldReconnect || conn.ws?.readyState === 0 || conn.ws?.readyState === 1) {
        if (generation === conn.generation) conn.connecting = false;
        return;
      }
      const ws = managedSession
        ? new WebSocket(url, ["nostr", `relay-app.${managedSession.token}`])
        : new WebSocket(url);
      conn.ws = ws;
      conn.connecting = false;
      conn.ready = false;
      conn.connectStartedAt = Date.now();
      if (conn.connectTimer) window.clearTimeout(conn.connectTimer);
      conn.connectTimer = window.setTimeout(() => {
        if (conn.ws !== ws || conn.ready) return;
        debugLog("relay", "relay_connection_timeout", {
          relay: url,
          reconnectAttempts: conn.reconnectAttempts,
          timeoutMs: CONNECTION_OPEN_TIMEOUT
        }, "warn");
        conn.pendingCloseReason = "timeout";
        try { ws.close(); } catch {}
      }, CONNECTION_OPEN_TIMEOUT);

      const onOpen = () => {
        if (conn.ws !== ws || generation !== conn.generation) return;
        if (conn.connectTimer) window.clearTimeout(conn.connectTimer);
        conn.connectTimer = null;
        const reconnected = conn.hasConnected;
        conn.pendingCloseReason = null;
        const reconnectAttempts = conn.reconnectAttempts;
        conn.ready = true;
        conn.hasConnected = true;
        conn.connectedAt = Date.now();
        if (conn.sessionRefreshTimer) window.clearTimeout(conn.sessionRefreshTimer);
        conn.sessionRefreshTimer = null;
        if (managedSession) {
          const refreshIn = Math.max(1_000, managedSession.expiresAt * 1000 - Date.now() - 30_000);
          conn.sessionRefreshTimer = window.setTimeout(() => {
            if (conn.ws !== ws || !conn.shouldReconnect) return;
            debugLog("relay", "relay_session_refresh", { relay: url }, "info");
            conn.pendingCloseReason = "session-refresh";
            try { ws.close(4001, "relay session refresh"); } catch {}
          }, refreshIn);
        }
        debugLog("relay", "relay_connected", { relay: url, reconnectAttempts }, "info");
        for (const [subId, sub] of conn.subs) {
          sub.settled = false;
          if (sub.eoseTimer) clearTimeout(sub.eoseTimer);
          sub.eoseTimer = setTimeout(() => {
            settleSubscription(conn, subId, "failure", "timeout");
          }, EOSE_TIMEOUT);
        }
        const queuedReqIds = queuedSubscriptionIds(conn.queue);
        // flush queue
        while (conn.queue.length) {
          const m = conn.queue.shift()!;
          try {
            ws.send(m);
            logWireSend(conn, m);
          } catch (e) {
            if (!conn.queue.includes(m)) conn.queue.push(m);
            logger.warn(`[relay] queued send failed relay=${url}`, e);
            break;
          }
        }
        replaySubscriptions(conn, ws, queuedReqIds);
        const at = Date.now();
        emitConnectionState({
          url,
          connected: true,
          reconnected,
          failed: false,
          at,
          latency: Math.max(0, at - conn.connectStartedAt)
        });
      };

      const onMessage = (ev: MessageEvent) => {
        if (conn.ws !== ws || generation !== conn.generation) return;
        let data: any;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (!Array.isArray(data) || data.length === 0) return;
        const t = data[0];
        if (t === "EVENT") {
          const subId = data[1];
          const event = data[2];
          const recipient = Array.isArray(event?.tags)
            ? event.tags.find((tag: unknown) => Array.isArray(tag) && tag[0] === "p")?.[1]
            : undefined;
          debugLog("relay", "relay_event_received", {
            relay: url,
            subId,
            eventId: typeof event?.id === "string" ? event.id.slice(0, 12) : "unknown",
            kind: event?.kind,
            recipientPrefix: typeof recipient === "string" ? recipient.slice(0, 12) : undefined,
            createdAt: event?.created_at
          });
          if (event?.kind === 1059) {
            logger.debug("[relay] nip17_event", {
              relay: url,
              subId,
              eventId: typeof event.id === "string" ? event.id.slice(0, 12) : "unknown",
              recipient: typeof recipient === "string" ? recipient.slice(0, 12) : "missing",
              created_at: event.created_at
            });
          }
          const s = conn.subs.get(subId);
          if (s) {
            for (const h of s.handlers) {
              try { h(event, url); } catch (e) { logger.warn("handler error", e); }
            }
          }
      } else if (t === "EOSE") {
          const subId = data[1];
          debugLog("subscription", "eose_received", subscriptionDiagnostic(conn, subId));
          settleSubscription(conn, subId, "eose");
      } else if (t === "OK") {
          const id = data[1];
          const ok = data[2];
          const msg = data[3];
          const h = conn.okHandlers.get(id);
          if (h) {
            try { h({ ok, msg }); } catch (e) { logger.warn("ok handler error", e); }
            conn.okHandlers.delete(id);
          }
        } else {
          if (t === "CLOSED") {
            const subId = data[1];
            settleSubscription(conn, subId, "failure", "closed");
          }
        }
      };

      const onClose = () => {
        if (conn.ws !== ws || generation !== conn.generation) return;
        if (conn.connectTimer) window.clearTimeout(conn.connectTimer);
        conn.connectTimer = null;
        conn.ready = false;
        conn.ws = null;
        conn.connecting = false;
        // A socket that flaps immediately after OPEN must not reset backoff.
        // Reset only after a stable connection, limiting rapid battery-draining loops.
        if (conn.connectedAt && Date.now() - conn.connectedAt >= RECONNECT_STABLE_MS) {
          conn.reconnectAttempts = 0;
        }
        conn.connectedAt = 0;
        if (conn.sessionRefreshTimer) window.clearTimeout(conn.sessionRefreshTimer);
        conn.sessionRefreshTimer = null;
        if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
        conn.retryAt = null;
        conn.lastDisconnectReason = conn.pendingCloseReason || "closed";
        conn.pendingCloseReason = null;
        emitConnectionState({
          url,
          connected: false,
          reconnected: conn.hasConnected,
          failed: conn.shouldReconnect,
          at: Date.now()
        });
        debugLog("relay", "relay_disconnected", { relay: url, reconnectAttempts: conn.reconnectAttempts }, "warn");
        if (!conn.shouldReconnect) return;
        for (const subId of conn.subs.keys()) {
          settleSubscription(conn, subId, "failure", "disconnected");
        }
        scheduleReconnect(() => { void create(); });
      };

      const onError = () => {
        if (conn.ws !== ws || generation !== conn.generation) return;
        debugLog("relay", "relay_error", { relay: url, reconnectAttempts: conn.reconnectAttempts }, "error");
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    } catch (e) {
      if (generation !== conn.generation) return;
      conn.connecting = false;
      debugLog("relay", "relay_error", {
        relay: url,
        reconnectAttempts: conn.reconnectAttempts,
        reason: e instanceof Error ? e.name : "websocket_create_failed"
      }, "error");
      logger.warn("create websocket failed for relay", url, e);
      emitConnectionState({
        url,
        connected: false,
        reconnected: conn.hasConnected,
        failed: true,
        at: Date.now()
      });
      scheduleReconnect(create);
    }
  };

  conn.connect = () => { void create(); };
  updateRelayIdleLease(conn);
  void create();
  return conn;
}

/** Start active relay connections without creating subscriptions or traffic. */
export function warmRelays(relays: string[]) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  for (const url of [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))]) {
    const existing = relaysMap[url];
    const conn = existing || ensureRelayConn(url);
    renewRelayIdleLease(conn);
    if (!existing || conn.ready || conn.connecting || conn.ws?.readyState === 1 || conn.ws?.readyState === 0) continue;
    if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    conn.retryAt = null;
    conn.shouldReconnect = true;
    conn.connect();
  }
}

function sendRaw(conn: RelayConn, payload: any): "sent" | "queued" {
  const s = JSON.stringify(payload);
  if (conn.ready && conn.ws) {
    try {
      conn.ws.send(s);
      logWireSend(conn, s);
      return "sent";
    } catch (e) {
      conn.queue.push(s);
      return "queued";
    }
  } else {
    conn.queue.push(s);
    return "queued";
  }
}

/**
 * subscribe(relays, filtersArray)
 * - returns { on(eventName, cb), unsub() }
 */
export function subscribe(relays: string[], filtersArray: any[]) {
  const filters = Array.isArray(filtersArray) ? filtersArray : [filtersArray];
  const perRelaySubIds: Array<{ url: string; subId: string; timer: ReturnType<typeof setTimeout> } > = [];

  for (const rawUrl of [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))]) {
    const url = rawUrl;
    const conn = ensureRelayConn(url);
    const subId = "sub_" + Math.random().toString(36).slice(2, 10);
    conn.subs.set(subId, { filters, handlers: new Set(), eoseHandlers: new Set(), failureHandlers: new Set(), settled: false });
    updateRelayIdleLease(conn);
    debugLog("subscription", "subscription_created", subscriptionDiagnostic(conn, subId, filters), "info");
    sendRaw(conn, ["REQ", subId, ...filters]);
    const timer = setTimeout(() => {
      settleSubscription(conn, subId, "failure", "timeout");
    }, EOSE_TIMEOUT);
    conn.subs.get(subId)!.eoseTimer = timer;
    perRelaySubIds.push({ url, subId, timer });
  }

  return {
    on(eventName: string, cb: (...args: any[]) => void) {
      if (eventName === "event") {
        for (const { url, subId } of perRelaySubIds) {
          const conn = relaysMap[url];
          if (!conn) continue;
          const s = conn.subs.get(subId);
          if (s) s.handlers.add(cb as any);
        }
      } else if (eventName === "eose") {
        for (const { url, subId } of perRelaySubIds) {
          const conn = relaysMap[url];
          if (!conn) continue;
          const s = conn.subs.get(subId);
          if (s) s.eoseHandlers.add(cb as any);
        }
      } else if (eventName === "failure") {
        for (const { url, subId } of perRelaySubIds) {
          const conn = relaysMap[url];
          if (!conn) continue;
          const s = conn.subs.get(subId);
          if (s) s.failureHandlers.add(cb as any);
        }
      }
    },
    unsub() {
      for (const { url, subId, timer } of perRelaySubIds) {
        clearTimeout(timer);
        const conn = relaysMap[url];
        if (!conn) continue;
        if (!conn.subs.has(subId)) continue;
        // A disconnected relay has never seen pending REQs on its next socket.
        // Remove only this subscription's queued frames; do not carry orphan
        // REQs/CLOSEs into a newly opened connection.
        conn.queue = conn.queue.filter(message => {
          try {
            const frame = JSON.parse(message);
            return !(Array.isArray(frame) && frame[1] === subId && (frame[0] === "REQ" || frame[0] === "CLOSE"));
          } catch { return true; }
        });
        if (conn.ready && conn.ws?.readyState === 1) {
          try { conn.ws.send(JSON.stringify(["CLOSE", subId])); } catch {
            // The socket is closing; its subscriptions disappear with it.
          }
        }
        debugLog("subscription", "subscription_closed", subscriptionDiagnostic(conn, subId), "info");
        conn.subs.delete(subId);
        if (!hasRelayDemand(conn)) {
          // Directory queries and completed one-off subscriptions close
          // immediately. The next lookup creates a fresh temporary socket.
          releaseRelayConnection(conn, "manual");
        } else {
          updateRelayIdleLease(conn);
        }
      }
    }
  };
}

/** A single wake-up signal and one bounded timeout replace 150 ms polling.
 * The listener is always disposed when a socket opens, is discarded or times out. */
function waitForRelayReady(conn: RelayConn, timeoutMs: number): Promise<boolean> {
  if (relaysMap[conn.url] !== conn || !conn.shouldReconnect) return Promise.resolve(false);
  if (conn.ready) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: () => void = () => {};
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      resolve(ready);
    };
    unsubscribe = onRelayConnectionState(event => {
      if (event.url !== conn.url) return;
      if (relaysMap[conn.url] !== conn || !conn.shouldReconnect) finish(false);
      else if (event.connected && conn.ready) finish(true);
    });
    timer = setTimeout(() => finish(false), timeoutMs);
    // Recheck after subscribing; a socket may open in the same event loop turn.
    if (conn.ready) finish(true);
    else if (relaysMap[conn.url] !== conn || !conn.shouldReconnect) finish(false);
  });
}

/**
 * publish(relays, event)
 * - returns Promise of array { relay, ok, reason?, ts }
 * - pending publishes retain ownership of the socket until settled
 */
export async function publish(relays: string[], event: any): Promise<Array<{ relay: string; ok: boolean; reason?: any; ts: number }>> {
  const promises = [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))].map(async (url) => {
    const conn = ensureRelayConn(url);
    conn.activePublishes++;
    updateRelayIdleLease(conn);
    const diagnostic = eventDiagnostic(conn, event);
    const id = event.id || Math.random().toString(36).slice(2, 10);
    let confirmationTimer: ReturnType<typeof setTimeout> | null = null;
    let confirmHandler: ((res: any) => void) | null = null;
    try {
      debugLog("publish", "publish_start", diagnostic, "info");
      debugLog("publish", "publish_waiting_connection", {
        ...diagnostic, ready: conn.ready, queueLength: conn.queue.length,
        wsReadyState: conn.ws?.readyState ?? null,
      });
      const waited = await waitForRelayReady(conn, CONNECT_TIMEOUT);
      debugLog("publish", waited ? "publish_connection_ready" : "publish_connection_timeout", {
        ...diagnostic, waited, ready: conn.ready, queueLength: conn.queue.length,
        wsReadyState: conn.ws?.readyState ?? null,
      }, waited ? "debug" : "warn");
      if (relaysMap[url] !== conn || !conn.shouldReconnect) {
        return { relay: url, ok: false, reason: "disconnected", ts: Date.now() };
      }
      const outcome = await new Promise<{ ok: boolean; msg?: any }>((resolve) => {
        const handler = (res: any) => {
          if (confirmationTimer !== null) clearTimeout(confirmationTimer);
          confirmationTimer = null;
          if (conn.okHandlers.get(id) === handler) conn.okHandlers.delete(id);
          const ok = !!res.ok;
          debugLog("publish", ok ? "publish_ok" : "publish_rejected", {
            ...diagnostic, reason: res.msg,
          }, ok ? "info" : "warn");
          resolve({ ok, msg: res.msg });
        };
        confirmHandler = handler;
        conn.okHandlers.set(id, handler);
        try {
          const delivery = sendRaw(conn, ["EVENT", event]);
          if (delivery === "queued") {
            debugLog("publish", "publish_send_queued", {
              ...diagnostic, ready: conn.ready, queueLength: conn.queue.length,
              wsReadyState: conn.ws?.readyState ?? null,
            }, "warn");
          }
        } catch (error) {
          handler({ ok: false, msg: error instanceof Error ? error.name : "send_failed" });
          return;
        }
        confirmationTimer = setTimeout(() => {
          if (conn.okHandlers.get(id) !== handler) return;
          conn.okHandlers.delete(id);
          confirmationTimer = null;
          debugLog("publish", "publish_timeout", {
            ...diagnostic, ready: conn.ready, queueLength: conn.queue.length,
            wsReadyState: conn.ws?.readyState ?? null,
          }, "warn");
          resolve({ ok: false, msg: "timeout" });
        }, PUBLISH_TIMEOUT);
      });
      return { relay: url, ok: outcome.ok, reason: outcome.msg, ts: Date.now() };
    } finally {
      if (confirmationTimer !== null) clearTimeout(confirmationTimer);
      if (confirmHandler && conn.okHandlers.get(id) === confirmHandler) conn.okHandlers.delete(id);
      // Cancel queued events on timeout/abort; otherwise an already-failed
      // event could be silently transmitted by a later unrelated connection.
      conn.queue = conn.queue.filter(frame => {
        try {
          const payload = JSON.parse(frame);
          return !(payload?.[0] === "EVENT" && payload?.[1]?.id === id);
        } catch { return true; }
      });
      conn.activePublishes = Math.max(0, conn.activePublishes - 1);
      updateRelayIdleLease(conn);
    }
  });
  return Promise.all(promises);
}

/**
 * inspectRelays(): return map of relay -> status
 */
export function inspectRelays(): Record<string, RelayRuntimeStatus> {
  const out: Record<string, RelayRuntimeStatus> = {};
  for (const url of Object.keys(relaysMap)) {
    const r = relaysMap[url];
    const state: RelayRuntimeState = r.ready
      ? "connected"
      : r.reconnectTimer !== null
        ? "waiting-retry"
        : r.connecting || r.ws?.readyState === 0
          ? "connecting"
          : "disconnected";
    out[url] = {
      ready: r.ready,
      state,
      queueLength: r.queue.length,
      subs: r.subs.size,
      okHandlers: r.okHandlers.size,
      reconnectAttempts: r.reconnectAttempts,
      connectStartedAt: r.connectStartedAt,
      usage: r.subs.size ? "subscription" : hasRelayDemand(r) ? "publishing" : "idle",
      pendingPublishes: r.activePublishes,
      idleSince: r.idleSince,
      idleExpiresAt: r.idleExpiresAt,
      retryAt: r.retryAt,
      lastDisconnectReason: r.lastDisconnectReason
    };
  }
  return out;
}

export function getRelayPerformanceDiagnostics() {
  const states = Object.values(inspectRelays());
  return {
    activeRelayConnections: states.filter(state => state.ready || state.state === "connecting").length,
    subscriptionCount: states.reduce((sum, state) => sum + state.subs, 0),
    pendingPublishes: states.reduce((sum, state) => sum + state.pendingPublishes, 0),
    idleRelayConnections: states.filter(state => state.usage === "idle").length,
    idleConnectionsReleased,
    reconnectCount: performanceCounters.relayReconnectCount,
    indexedDbQueueSize: performanceCounters.indexedDbQueueSize,
    duplicateEventsDropped: performanceCounters.duplicateEventsDropped,
    eventCacheHit: performanceCounters.eventCacheHit,
    eventCacheMiss: performanceCounters.eventCacheMiss,
    decryptCacheHit: performanceCounters.decryptCacheHit,
    decryptCacheMiss: performanceCounters.decryptCacheMiss
  };
}

/**
 * Force a single Relay to reconnect without replacing its connection object.
 * Retaining its subscription map also retains REQ identity. An in-flight
 * publication is explicitly rejected for outbox retry, never orphaned.
 */
export function reconnectRelay(url: string) {
  url = normalizeRelayUrl(url);
  if (!url) return;
  const conn = relaysMap[url];
  if (!conn) {
    ensureRelayConn(url); // manual warm connection, covered by idle TTL
    return;
  }
  try {
    conn.lastDisconnectReason = "manual";
    conn.shouldReconnect = true;
    conn.generation++;
    if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer);
    if (conn.connectTimer !== null) clearTimeout(conn.connectTimer);
    if (conn.sessionRefreshTimer !== null) clearTimeout(conn.sessionRefreshTimer);
    conn.reconnectTimer = null;
    conn.retryAt = null;
    conn.connectTimer = null;
    conn.sessionRefreshTimer = null;
    conn.connecting = false;
    const socket = conn.ws;
    const wasReady = conn.ready;
    conn.ws = null;
    conn.ready = false;
    // The previous socket's OK response is now unknowable. Explicitly fail
    // its pending confirmations; do not discard callbacks or replay a possibly
    // accepted encrypted event behind the publisher's back.
    failRelayAcknowledgements(conn, "relay_reconnected");
    try { socket?.close(); } catch {}
    if (wasReady) emitConnectionState({ url, connected: false, reconnected: conn.hasConnected, failed: false, at: Date.now() });
    renewRelayIdleLease(conn);
    conn.connect();
  } catch (error) {
    debugLog("relay", "relay_error", {
      relay: url,
      reconnectAttempts: conn.reconnectAttempts,
      reason: error instanceof Error ? error.name : "reconnect_failed",
    }, "error");
    logger.warn("reconnectRelay error", error);
  }
}

/** Permanently stop and forget a Relay removed from settings or locked out. */
export function disconnectRelay(url: string) {
  url = normalizeRelayUrl(url);
  if (!url) return;
  const conn = relaysMap[url];
  if (conn) releaseRelayConnection(conn, "settings");
}

/**
 * pool facade for compatibility (minimal)
 */
export const pool = {
  async publish(relays: string[], event: any) {
    return await publish(relays, event);
  },
  subscribeMany(relays: string[], filtersArray: any[], callbacks?: any) {
    const sub = subscribe(relays, filtersArray);
    if (callbacks && typeof callbacks === "object") {
      if (typeof callbacks.onevent === "function") {
        sub.on("event", (evt: any) => {
          try { callbacks.onevent(evt); } catch (e) { logger.warn("onevent cb error", e); }
        });
      }
      if (typeof callbacks.oneose === "function") {
        sub.on("eose", (relayUrl: string) => {
          try { callbacks.oneose(relayUrl); } catch (e) { logger.warn("oneose cb error", e); }
        });
      }
      return {
        close() { try { sub.unsub(); } catch {} },
        unsub() { try { sub.unsub(); } catch {} },
        on(eventName: string, cb: any) { sub.on(eventName, cb); }
      };
    }
    return sub;
  }
};

/** Reset foreground retry exhaustion and immediately reconnect active read relays. */
export function restoreRelayConnections(relays = getRelaysFromStorage("read")) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  for (const url of [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))]) {
    const conn = relaysMap[url] || ensureRelayConn(url);
    renewRelayIdleLease(conn);
    if (conn.ready || conn.ws?.readyState === 1 || conn.ws?.readyState === 0) continue;
    if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    conn.retryAt = null;
    conn.shouldReconnect = true;
    conn.connect();
  }
}

