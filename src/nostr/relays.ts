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
  type RelayConfig
} from "@/services/connectionSettings";

type RelayConn = {
  url: string;
  ws: WebSocket | null;
  ready: boolean;
  queue: string[];
  subs: Map<string, { filters: any[]; handlers: Set<(evt: any, relayUrl: string) => void>; eoseHandlers: Set<(relayUrl: string) => void> }>;
  okHandlers: Map<string, (res: any) => void>;
  reconnectTimer?: number | null;
  reconnectAttempts: number;
  hasConnected: boolean;
  shouldReconnect: boolean;
  connectStartedAt: number;
};

const CONNECT_TIMEOUT = 4000;
const PUBLISH_TIMEOUT = 5000;
const RECONNECT_DELAYS = [30_000, 60_000, 300_000, 900_000, 1_800_000];

const relaysMap: Record<string, RelayConn> = {};
export type RelayConnectionEvent = {
  url: string;
  connected: boolean;
  reconnected: boolean;
  failed: boolean;
  at: number;
  latency?: number;
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
    const structuredRaw = localStorage.getItem(ACTIVE_RELAY_CONFIGS_KEY);
    if (structuredRaw !== null) {
      const structured = JSON.parse(structuredRaw) as RelayConfig[];
      if (!Array.isArray(structured)) throw new Error("invalid relay configuration mirror");
      const matching = structured.filter(relay =>
        relay.enabled !== false
        && !relay.deleted
        && (mode === "both" ? relay.read || relay.write : relay[mode])
      );
      return [...new Set(matching.map(relay => relay.url))];
    }
    const raw = localStorage.getItem("custom-relays");
    if (raw) return [...new Set(raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
  } catch {
    // Defaults keep startup and offline restore usable when a mirror is corrupt.
  }
  return DEFAULT_RELAYS.slice();
}

function ensureRelayConn(url: string): RelayConn {
  if (relaysMap[url]) return relaysMap[url];

  const conn: RelayConn = {
    url,
    ws: null,
    ready: false,
    queue: [],
    subs: new Map(),
    okHandlers: new Map(),
    reconnectTimer: null,
    reconnectAttempts: 0,
    hasConnected: false,
    shouldReconnect: true,
    connectStartedAt: Date.now()
  };
  relaysMap[url] = conn;

  const scheduleReconnect = (create: () => void) => {
    if (!conn.shouldReconnect) return;
    if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
    const attempt = conn.reconnectAttempts++;
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    debugLog("relay", "relay_reconnect_scheduled", {
      relay: url,
      reconnectAttempts: conn.reconnectAttempts,
      delayMs: delay
    }, "warn");
    conn.reconnectTimer = window.setTimeout(() => {
      conn.reconnectTimer = null;
      create();
    }, delay);
  };

  const create = () => {
    if (!conn.shouldReconnect) return;
    debugLog("relay", "relay_connecting", { relay: url, reconnectAttempts: conn.reconnectAttempts }, "info");
    try {
      const ws = new WebSocket(url);
      conn.ws = ws;
      conn.ready = false;
      conn.connectStartedAt = Date.now();

      const onOpen = () => {
        const reconnected = conn.hasConnected;
        const reconnectAttempts = conn.reconnectAttempts;
        conn.ready = true;
        conn.hasConnected = true;
        conn.reconnectAttempts = 0;
        debugLog("relay", "relay_connected", { relay: url, reconnectAttempts }, "info");
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
          const s = conn.subs.get(subId);
          if (s) {
            for (const eh of s.eoseHandlers) {
              try { eh(url); } catch (e) { logger.warn("eose handler error", e); }
            }
          }
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
          // ignore others
        }
      };

      const onClose = () => {
        conn.ready = false;
        conn.ws = null;
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
        logger.warn(`[relay] disconnected relay=${url}; reconnect scheduled`);
        scheduleReconnect(create);
      };

      const onError = () => {
        debugLog("relay", "relay_error", { relay: url, reconnectAttempts: conn.reconnectAttempts }, "error");
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    } catch (e) {
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

  create();
  return conn;
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
  const perRelaySubIds: Array<{ url: string; subId: string } > = [];

  for (const url of relays) {
    const conn = ensureRelayConn(url);
    const subId = "sub_" + Math.random().toString(36).slice(2, 10);
    conn.subs.set(subId, { filters, handlers: new Set(), eoseHandlers: new Set() });
    debugLog("subscription", "subscription_created", subscriptionDiagnostic(conn, subId, filters), "info");
    sendRaw(conn, ["REQ", subId, ...filters]);
    perRelaySubIds.push({ url, subId });
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
      }
    },
    unsub() {
      for (const { url, subId } of perRelaySubIds) {
        const conn = relaysMap[url];
        if (!conn) continue;
        try { sendRaw(conn, ["CLOSE", subId]); } catch {}
        debugLog("subscription", "subscription_closed", subscriptionDiagnostic(conn, subId), "info");
        conn.subs.delete(subId);
      }
    }
  };
}

/**
 * publish(relays, event)
 * - returns Promise of array { relay, ok, reason?, ts }
 */
export async function publish(relays: string[], event: any): Promise<Array<{ relay: string; ok: boolean; reason?: any; ts: number }>> {
  const promises = relays.map(async (url) => {
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
    return { relay: url, ok: !!r.ok, reason: r.msg, ts: Date.now() };
  });

  return Promise.all(promises);
}

/**
 * inspectRelays(): return map of relay -> status
 */
export function inspectRelays() {
  const out: any = {};
  for (const url of Object.keys(relaysMap)) {
    const r = relaysMap[url];
    out[url] = {
      ready: r.ready,
      queueLength: r.queue.length,
      subs: Array.from(r.subs.keys()).length,
      okHandlers: Array.from(r.okHandlers.keys()).length,
      reconnectAttempts: r.reconnectAttempts
    };
  }
  return out;
}

/**
 * reconnectRelay(url): force reconnect by closing and recreating connection
 */
export function reconnectRelay(url: string) {
  const r = relaysMap[url];
  if (!r) {
    // create a new connection proactively
    ensureRelayConn(url);
    return;
  }
  try {
    const subscriptions = r.subs;
    r.shouldReconnect = false;
    if (r.reconnectTimer) window.clearTimeout(r.reconnectTimer);
    r.reconnectTimer = null;
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
  const conn = relaysMap[url];
  if (!conn) return;
  conn.shouldReconnect = false;
  if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
  conn.reconnectTimer = null;
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
