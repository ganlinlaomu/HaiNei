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
  shouldReconnect: boolean;
  connectStartedAt: number;
  connect: () => void;
};

const CONNECT_TIMEOUT = 4000;
const CONNECTION_OPEN_TIMEOUT = 10_000;
const PUBLISH_TIMEOUT = 5000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 60_000;
const EOSE_TIMEOUT = 8_000;

const relaysMap: Record<string, RelayConn> = {};
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
    hasConnected: false,
    shouldReconnect: true,
    connectStartedAt: Date.now(),
    connect: () => undefined
  };
  relaysMap[url] = conn;

  const scheduleReconnect = (create: () => void) => {
    if (!conn.shouldReconnect) return;
    const hasDemand = conn.subs.size > 0 || conn.okHandlers.size > 0 || conn.queue.length > 0;
    if (!hasDemand) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
    const attempt = conn.reconnectAttempts++;
    const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6));
    const jitteredDelay = Math.round(delay * (0.75 + Math.random() * 0.5));
    debugLog("relay", "relay_reconnect_scheduled", {
      relay: url,
      reconnectAttempts: conn.reconnectAttempts,
      delayMs: jitteredDelay
    }, "warn");
    conn.reconnectTimer = window.setTimeout(() => {
      conn.reconnectTimer = null;
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
        try { ws.close(); } catch {}
      }, CONNECTION_OPEN_TIMEOUT);

      const onOpen = () => {
        if (conn.ws !== ws || generation !== conn.generation) return;
        if (conn.connectTimer) window.clearTimeout(conn.connectTimer);
        conn.connectTimer = null;
        const reconnected = conn.hasConnected;
        const reconnectAttempts = conn.reconnectAttempts;
        conn.ready = true;
        conn.hasConnected = true;
        conn.reconnectAttempts = 0;
        if (conn.sessionRefreshTimer) window.clearTimeout(conn.sessionRefreshTimer);
        conn.sessionRefreshTimer = null;
        if (managedSession) {
          const refreshIn = Math.max(1_000, managedSession.expiresAt * 1000 - Date.now() - 30_000);
          conn.sessionRefreshTimer = window.setTimeout(() => {
            if (conn.ws !== ws || !conn.shouldReconnect) return;
            debugLog("relay", "relay_session_refresh", { relay: url }, "info");
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
        if (conn.sessionRefreshTimer) window.clearTimeout(conn.sessionRefreshTimer);
        conn.sessionRefreshTimer = null;
        if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
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
  void create();
  return conn;
}

/** Start active relay connections without creating subscriptions or traffic. */
export function warmRelays(relays: string[]) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  for (const url of [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))]) {
    const existing = relaysMap[url];
    const conn = existing || ensureRelayConn(url);
    if (!existing || conn.ready || conn.connecting || conn.ws?.readyState === 1 || conn.ws?.readyState === 0) continue;
    if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
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
        if (conn.subs.size === 0 && conn.okHandlers.size === 0) {
          conn.shouldReconnect = false;
          conn.generation++;
          if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
          if (conn.connectTimer) window.clearTimeout(conn.connectTimer);
          if (conn.sessionRefreshTimer) window.clearTimeout(conn.sessionRefreshTimer);
          conn.reconnectTimer = null;
          conn.connectTimer = null;
          conn.sessionRefreshTimer = null;
          conn.connecting = false;
          const wasReady = conn.ready;
          const socket = conn.ws;
          conn.ws = null;
          conn.ready = false;
          conn.queue = conn.queue.filter(message => {
            try { return JSON.parse(message)?.[0] !== "REQ"; } catch { return true; }
          });
          try { socket?.close(); } catch {}
          delete relaysMap[url];
          if (wasReady) emitConnectionState({ url, connected: false, reconnected: conn.hasConnected, failed: false, at: Date.now() });
        }
      }
    }
  };
}

/**
 * publish(relays, event)
 * - returns Promise of array { relay, ok, reason?, ts }
 */
export async function publish(relays: string[], event: any): Promise<Array<{ relay: string; ok: boolean; reason?: any; ts: number }>> {
  const promises = [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))].map(async (url) => {
    const conn = ensureRelayConn(url);
    const diagnostic = eventDiagnostic(conn, event);
    debugLog("publish", "publish_start", diagnostic, "info");
    debugLog("publish", "publish_waiting_connection", {
      ...diagnostic,
      ready: conn.ready,
      queueLength: conn.queue.length,
      wsReadyState: conn.ws?.readyState ?? null
    });
    const waited = await new Promise<boolean>((resolve) => {
      const start = Date.now();
      const check = () => {
        if (conn.ready) return resolve(true);
        if (Date.now() - start > CONNECT_TIMEOUT) return resolve(false);
        setTimeout(check, 150);
      };
      check();
    });
    debugLog("publish", waited ? "publish_connection_ready" : "publish_connection_timeout", {
      ...diagnostic,
      waited,
      ready: conn.ready,
      queueLength: conn.queue.length,
      wsReadyState: conn.ws?.readyState ?? null
    }, waited ? "debug" : "warn");

    const id = event.id || (Math.random().toString(36).slice(2, 10));
    const okPromise = new Promise<{ ok: boolean; msg?: any }>((resolve) => {
      const h = (res: any) => {
        const ok = !!res.ok;
        debugLog("publish", ok ? "publish_ok" : "publish_rejected", {
          ...diagnostic,
          reason: res.msg
        }, ok ? "info" : "warn");
        resolve({ ok, msg: res.msg });
      };
      conn.okHandlers.set(id, h);
      setTimeout(() => {
        if (conn.okHandlers.has(id)) {
          conn.okHandlers.delete(id);
          debugLog("publish", "publish_timeout", {
            ...diagnostic,
            ready: conn.ready,
            queueLength: conn.queue.length,
            wsReadyState: conn.ws?.readyState ?? null
          }, "warn");
          resolve({ ok: false, msg: "timeout" });
        }
      }, PUBLISH_TIMEOUT);
    });

    try {
      const delivery = sendRaw(conn, ["EVENT", event]);
      if (delivery === "queued") {
        debugLog("publish", "publish_send_queued", {
          ...diagnostic,
          ready: conn.ready,
          queueLength: conn.queue.length,
          wsReadyState: conn.ws?.readyState ?? null
        }, "warn");
      }
    } catch (e) {
      conn.okHandlers.delete(id);
      debugLog("publish", "publish_rejected", {
        ...diagnostic,
        reason: e instanceof Error ? e.name : "send_failed"
      }, "error");
      return { relay: url, ok: false, reason: e, ts: Date.now() };
    }

    const r = await okPromise;
    conn.queue = conn.queue.filter(message => {
      try {
        const payload = JSON.parse(message);
        return !(payload?.[0] === "EVENT" && payload?.[1]?.id === id);
      } catch { return true; }
    });
    if (conn.subs.size === 0 && conn.okHandlers.size === 0) {
      conn.shouldReconnect = false;
      if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
      try { conn.ws?.close(); } catch {}
      delete relaysMap[url];
    }
    return { relay: url, ok: !!r.ok, reason: r.msg, ts: Date.now() };
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
      subs: Array.from(r.subs.keys()).length,
      okHandlers: Array.from(r.okHandlers.keys()).length,
      reconnectAttempts: r.reconnectAttempts,
      connectStartedAt: r.connectStartedAt
    };
  }
  return out;
}

export function getRelayPerformanceDiagnostics() {
  const states = Object.values(inspectRelays());
  return {
    activeRelayConnections: states.filter(state => state.ready || state.state === "connecting").length,
    subscriptionCount: states.reduce((sum, state) => sum + state.subs, 0),
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
 * reconnectRelay(url): force reconnect by closing and recreating connection
 */
export function reconnectRelay(url: string) {
  url = normalizeRelayUrl(url);
  if (!url) return;
  const r = relaysMap[url];
  if (!r) {
    // create a new connection proactively
    ensureRelayConn(url);
    return;
  }
  try {
    const subscriptions = r.subs;
    r.shouldReconnect = false;
    r.generation++;
    if (r.reconnectTimer) window.clearTimeout(r.reconnectTimer);
    if (r.connectTimer) window.clearTimeout(r.connectTimer);
    if (r.sessionRefreshTimer) window.clearTimeout(r.sessionRefreshTimer);
    r.reconnectTimer = null;
    r.connectTimer = null;
    r.sessionRefreshTimer = null;
    r.connecting = false;
    try { r.ws?.close(); } catch {}
    r.ready = false;
    r.okHandlers.clear();
    delete relaysMap[url];
    const replacement = ensureRelayConn(url);
    replacement.subs = subscriptions;
  } catch (e) {
    debugLog("relay", "relay_error", {
      relay: url,
      reconnectAttempts: r.reconnectAttempts,
      reason: e instanceof Error ? e.name : "reconnect_failed"
    }, "error");
    logger.warn("reconnectRelay error", e);
  }
}

/** Permanently stop and forget a relay that was removed from settings. */
export function disconnectRelay(url: string) {
  url = normalizeRelayUrl(url);
  if (!url) return;
  const conn = relaysMap[url];
  if (!conn) return;
  conn.shouldReconnect = false;
  conn.generation++;
  if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
  if (conn.connectTimer) window.clearTimeout(conn.connectTimer);
  if (conn.sessionRefreshTimer) window.clearTimeout(conn.sessionRefreshTimer);
  conn.reconnectTimer = null;
  conn.connectTimer = null;
  conn.sessionRefreshTimer = null;
  conn.connecting = false;
  conn.queue = [];
  conn.subs.clear();
  conn.okHandlers.clear();
  try { conn.ws?.close(); } catch {}
  conn.ws = null;
  conn.ready = false;
  delete relaysMap[url];
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
    if (conn.ready || conn.ws?.readyState === 1 || conn.ws?.readyState === 0) continue;
    if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    conn.shouldReconnect = true;
    conn.connect();
  }
}

