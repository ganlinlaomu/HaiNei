// WebSocket-based minimal Nostr relay adapter (cleaned up, with debug toggle and reconnect)
// Exports:
// - DEFAULT_RELAYS
// - getRelaysFromStorage()
// - subscribe(relays, filtersArray)
// - publish(relays, event)
// - inspectRelays(): relay status summary
// - reconnectRelay(url): force reconnect of one relay
import { logger } from "@/utils/logger";

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
};

const CONNECT_TIMEOUT = 4000;
const PUBLISH_TIMEOUT = 5000;
const MAX_RECONNECT_DELAY = 30000;

const relaysMap: Record<string, RelayConn> = {};
export type RelayConnectionEvent = { url: string; connected: boolean; reconnected: boolean; at: number };
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

function replaySubscriptions(conn: RelayConn, ws: WebSocket, queuedReqIds: Set<string>) {
  for (const [subId, sub] of conn.subs.entries()) {
    // A subscription created while disconnected already has its REQ in the queue.
    if (queuedReqIds.has(subId)) continue;
    try {
      ws.send(JSON.stringify(["REQ", subId, ...sub.filters]));
      logger.info(`[relay] replay subscription relay=${conn.url} sub=${subId}`);
    } catch (e) {
      const request = JSON.stringify(["REQ", subId, ...sub.filters]);
      if (!conn.queue.includes(request)) conn.queue.push(request);
      logger.warn(`[relay] subscription replay failed relay=${conn.url} sub=${subId}`, e);
    }
  }
}

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.0xchat.com",
];

export function getRelaysFromStorage() {
  const raw = localStorage.getItem("custom-relays");
  if (!raw) return DEFAULT_RELAYS.slice();
  return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
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
    hasConnected: false
  };
  relaysMap[url] = conn;

  const create = () => {
    try {
      const ws = new WebSocket(url);
      conn.ws = ws;
      conn.ready = false;

      const onOpen = () => {
        const reconnected = conn.hasConnected;
        conn.ready = true;
        conn.hasConnected = true;
        conn.reconnectAttempts = 0;
        const queuedReqIds = queuedSubscriptionIds(conn.queue);
        // flush queue
        while (conn.queue.length) {
          const m = conn.queue.shift()!;
          try { ws.send(m); } catch (e) {
            if (!conn.queue.includes(m)) conn.queue.push(m);
            logger.warn(`[relay] queued send failed relay=${url}`, e);
            break;
          }
        }
        replaySubscriptions(conn, ws, queuedReqIds);
        emitConnectionState({ url, connected: true, reconnected, at: Date.now() });
      };

      const onMessage = (ev: MessageEvent) => {
        let data: any;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (!Array.isArray(data) || data.length === 0) return;
        const t = data[0];
        if (t === "EVENT") {
          const subId = data[1];
          const event = data[2];
          const s = conn.subs.get(subId);
          if (s) {
            for (const h of s.handlers) {
              try { h(event, url); } catch (e) { logger.warn("handler error", e); }
            }
          }
        } else if (t === "EOSE") {
          const subId = data[1];
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
        logger.warn(`[relay] disconnected relay=${url}; reconnect scheduled`);
        conn.ready = false;
        conn.ws = null;
        if (conn.reconnectTimer) window.clearTimeout(conn.reconnectTimer);
        emitConnectionState({ url, connected: false, reconnected: conn.hasConnected, at: Date.now() });
        const attempt = conn.reconnectAttempts++;
        const baseDelay = Math.min(MAX_RECONNECT_DELAY, 1000 * (2 ** attempt));
        const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
        conn.reconnectTimer = window.setTimeout(() => {
          conn.reconnectTimer = null;
          create();
        }, delay);
      };

      const onError = () => { /* ignore: close will handle reconnect */ };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    } catch (e) {
      logger.warn("create websocket failed for relay", url, e);
    }
  };

  create();
  return conn;
}

function sendRaw(conn: RelayConn, payload: any) {
  const s = JSON.stringify(payload);
  if (conn.ready && conn.ws) {
    try { conn.ws.send(s); } catch (e) { conn.queue.push(s); }
  } else {
    conn.queue.push(s);
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
    const waited = await new Promise<boolean>((resolve) => {
      const start = Date.now();
      const check = () => {
        if (conn.ready) return resolve(true);
        if (Date.now() - start > CONNECT_TIMEOUT) return resolve(false);
        setTimeout(check, 150);
      };
      check();
    });

    const id = event.id || (Math.random().toString(36).slice(2, 10));
    const okPromise = new Promise<{ ok: boolean; msg?: any }>((resolve) => {
      const h = (res: any) => resolve({ ok: !!res.ok, msg: res.msg });
      conn.okHandlers.set(id, h);
      setTimeout(() => {
        if (conn.okHandlers.has(id)) {
          conn.okHandlers.delete(id);
          resolve({ ok: false, msg: "timeout" });
        }
      }, PUBLISH_TIMEOUT);
    });

    try {
      sendRaw(conn, ["EVENT", event]);
    } catch (e) {
      conn.okHandlers.delete(id);
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
    if (r.ws) {
      try { r.ws.close(); } catch { }
    } else if (!r.reconnectTimer) {
      const subscriptions = r.subs;
      delete relaysMap[url];
      const replacement = ensureRelayConn(url);
      replacement.subs = subscriptions;
    }
    // Preserve active subscriptions so the next socket can replay their REQs.
    r.ready = false;
    r.okHandlers.clear();
  } catch (e) {
    logger.warn("reconnectRelay error", e);
  }
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
