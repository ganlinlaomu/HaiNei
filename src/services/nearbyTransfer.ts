import type { Room } from "trystero";
import { DEFAULT_RELAY_URLS } from "@/services/connectionSettings";
import { createNearbyRtcDiagnostics } from "@/services/nearbyRtcDiagnostics";

/**
 * 附近传输 between a person's own devices (and QR-paired browsers).
 *
 * Trystero joins a WebRTC room whose SDP is exchanged over our own Nostr
 * relays and encrypted with the room password; on the same Wi-Fi the files
 * then travel device-to-device over the LAN and are never uploaded.
 */

export const NEARBY_APP_ID = "hainei-nearby-v1";
/** iPhone keeps received files in memory; one batch must stay well below that. */
export const NEARBY_MAX_BATCH_BYTES = 1024 * 1024 * 1024;
export const NEARBY_OFFER_TIMEOUT_MS = 60_000;
/** Shown until a peer has told us its device name. */
export const NEARBY_UNNAMED_PEER = "正在识别…";
const HELLO_RETRY_MS = 4_000;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

export type NearbyRoomKey = { roomId: string; password: string };
export type NearbyFileMeta = { name: string; size: number; type: string };
export type NearbyOffer = { id: string; files: NearbyFileMeta[]; from: string };

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function derive(secret: string, label: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`hainei-nearby:${label}:${secret}`));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * The same account always lands in the same room on every device. Only
 * holders of the private key can compute it; relays see neither the account
 * nor the room (Trystero hashes it again with the app id).
 */
export async function ownDevicesRoom(privateKeyHex: string): Promise<NearbyRoomKey> {
  if (!/^[0-9a-f]{64}$/i.test(privateKeyHex)) throw new Error("nearby_requires_private_key");
  const secret = privateKeyHex.toLowerCase();
  return { roomId: await derive(secret, "own-room"), password: await derive(secret, "own-password") };
}

export function randomPairingRoom(): NearbyRoomKey {
  const hex = (bytes: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
  return { roomId: hex(16), password: hex(16) };
}

export function pairingLink(room: NearbyRoomKey, origin: string) {
  return `${origin}/#/nearby?pair=${room.roomId}.${room.password}`;
}

/** Accepts the full link or the bare "room.password" part (QR codes carry the link). */
export function parsePairing(value: string): NearbyRoomKey | null {
  const match = String(value || "").match(/([0-9a-f]{32})\.([0-9a-f]{32})/i);
  return match ? { roomId: match[1].toLowerCase(), password: match[2].toLowerCase() } : null;
}

const RELAY_PROBE_TIMEOUT_MS = 8_000;
let relayRefresh: Promise<number> | null = null;

/** Check application-level liveness before closing a possibly half-open socket.
 * Closing a healthy signaling socket discards Trystero's in-flight candidates.
 */
function probeNearbySocket(socket: WebSocket): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const id = `nearby-probe-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify(["CLOSE", id])); } catch { /* suspension */ }
      }
      resolve(healthy);
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string" || event.data.length > 1024 || !event.data.includes(id)) return;
      try {
        const [type, subscription] = JSON.parse(event.data);
        if (subscription === id && (type === "EOSE" || type === "CLOSED")) finish(true);
      } catch { /* not our response */ }
    };
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(false), RELAY_PROBE_TIMEOUT_MS);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    try {
      socket.send(JSON.stringify(["REQ", id, { kinds: [0], authors: ["0".repeat(64)], limit: 0 }]));
    } catch { finish(false); }
  });
}

async function checkNearbyRelaySockets() {
  const { getRelaySockets } = await import("trystero");
  const sockets = (getRelaySockets() || {}) as Record<string, WebSocket | undefined>;
  let refreshed = 0;
  await Promise.all(Object.values(sockets).map(async socket => {
    // Let the library finish an existing connection attempt by itself.
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!await probeNearbySocket(socket) && socket.readyState === WebSocket.OPEN) {
      socket.close();
      refreshed++;
    }
  }));
  return refreshed;
}

export function refreshNearbyRelaySockets() {
  return relayRefresh ??= checkNearbyRelaySockets().finally(() => { relayRefresh = null; });
}

/** Short, non-reversible label so two devices can compare rooms on screen. */
export async function roomFingerprint(roomId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`fingerprint:${roomId}`));
  return Array.from(new Uint8Array(digest).slice(0, 3), byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

const observedSockets = new WeakSet<WebSocket>();
const relayRejections = new WeakMap<WebSocket, string>();

function observeRelayRejections(socket: WebSocket) {
  if (observedSockets.has(socket)) return;
  observedSockets.add(socket);
  socket.addEventListener("message", event => {
    if (typeof event.data !== "string" || event.data.length > 2048) return;
    try {
      const [type, , payload, reason] = JSON.parse(event.data);
      if (type === "OK" && payload === true) relayRejections.delete(socket);
      const rejection = type === "CLOSED" ? payload : type === "OK" && payload === false ? reason : "";
      if (typeof rejection !== "string") return;
      if (rejection.startsWith("auth-required:")) relayRejections.set(socket, "Relay 要求认证，附近传输未认证");
      else if (rejection.startsWith("rate-limited:")) relayRejections.set(socket, "Relay 限流");
      else if (/^(blocked|restricted|pow):/.test(rejection)) relayRejections.set(socket, "Relay 拒绝访问");
    } catch { /* unrelated frame */ }
  });
}

export async function nearbyRelayStates() {
  const { getRelaySockets, selfId } = await import("trystero");
  const names = ["连接中", "已连接", "关闭中", "已断开"];
  const sockets = (getRelaySockets() || {}) as Record<string, WebSocket | undefined>;
  for (const socket of Object.values(sockets)) if (socket) observeRelayRejections(socket);
  return {
    selfId: String(selfId || "").slice(0, 6),
    relays: Object.entries(sockets).map(([url, socket]) => ({
      host: url.replace(/^wss?:\/\//, "").replace(/\/$/, ""),
      state: socket ? names[socket.readyState] || "未知" : "无",
      rejection: socket ? relayRejections.get(socket) || "" : "",
    })),
  };
}

export function defaultDeviceName(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  maxTouchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints || 0,
) {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(userAgent)) return /Mobile/.test(userAgent) ? "Android 手机" : "Android 平板";
  if (/Macintosh/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows 电脑";
  if (/CrOS/.test(userAgent)) return "Chromebook";
  if (/Linux/.test(userAgent)) return "Linux 电脑";
  return "浏览器";
}

export function sanitizeOffer(value: unknown, from: string): NearbyOffer | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { id?: unknown; files?: unknown };
  if (typeof raw.id !== "string" || !/^[0-9a-f]{16}$/.test(raw.id) || !Array.isArray(raw.files)) return null;
  const files = raw.files.slice(0, 200).map(file => {
    const item = (file || {}) as Record<string, unknown>;
    return {
      name: String(item.name || "文件").replace(/[\\/]/g, "_").slice(0, 200) || "文件",
      size: Math.max(0, Math.floor(Number(item.size) || 0)),
      type: String(item.type || "application/octet-stream").slice(0, 100),
    };
  });
  return files.length ? { id: raw.id, files, from } : null;
}

export function batchBytes(files: Pick<NearbyFileMeta, "size">[]) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export type NearbyRoomHandlers = {
  onPeers: (peers: Record<string, string>) => void;
  onError: (message: string) => void;
  /** Resolve true to accept. Called before any file bytes are sent. */
  onOffer: (offer: NearbyOffer) => Promise<boolean>;
  onReceiveProgress: (offerId: string, index: number, percent: number) => void;
  onFile: (offerId: string, index: number, file: File) => void;
};

/** One joined room: device names, offers that must be accepted, then files. */
export class NearbyRoom {
  private room: Room | null = null;
  private rtcDiagnostics: ReturnType<typeof createNearbyRtcDiagnostics> | null = null;
  private key: NearbyRoomKey | null = null;
  private generation = 0;
  private readonly names: Record<string, string> = {};
  private readonly accepted = new Map<string, { from: string; files: NearbyFileMeta[] }>();
  private sendHello: ((reply: boolean, target: string) => Promise<void>) | null = null;
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private requestOffer: ((offer: Omit<NearbyOffer, "from">, target: string) => Promise<boolean>) | null = null;
  private sendFile: ((data: Blob, target: string, metadata: { offerId: string; index: number }, onProgress: (percent: number) => void) => Promise<void>) | null = null;

  constructor(private readonly deviceName: string, private readonly handlers: NearbyRoomHandlers) {}

  async join(key: NearbyRoomKey) {
    const generation = ++this.generation;
    this.key = key;
    const { joinRoom, getRelaySockets } = await import("trystero");
    if (generation !== this.generation) return;
    const active = () => generation === this.generation;
    this.rtcDiagnostics = createNearbyRtcDiagnostics(RTCPeerConnection);
    const room = joinRoom({
      appId: NEARBY_APP_ID,
      password: key.password,
      maxReceiveBytes: NEARBY_MAX_BATCH_BYTES,
      relayConfig: { urls: [...DEFAULT_RELAY_URLS], redundancy: DEFAULT_RELAY_URLS.length },
      rtcConfig: { iceServers: ICE_SERVERS },
      rtcPolyfill: this.rtcDiagnostics.PeerConnection,
    }, key.roomId, {
      onJoinError: ({ error }) => { if (active()) this.handlers.onError(error); },
    });
    this.room = room;
    const sockets = getRelaySockets() as Record<string, WebSocket | undefined>;
    for (const socket of Object.values(sockets)) if (socket) observeRelayRejections(socket);

    // Names are exchanged both ways: a peer that rejoined (or missed our
    // first hello) asks again, and unnamed peers are re-greeted until known.
    const hello = room.makeAction<{ name: string; reply: boolean }>("hello", {
      onMessage: (data, { peerId }) => {
        if (!active()) return;
        const wasKnown = !!this.names[peerId] && this.names[peerId] !== NEARBY_UNNAMED_PEER;
        this.names[peerId] = String(data?.name || "附近的设备").slice(0, 40);
        this.handlers.onPeers({ ...this.names });
        if (!data?.reply || !wasKnown) void this.sendHello?.(true, peerId);
      },
    });
    this.sendHello = (reply, target) => hello.send({ name: this.deviceName, reply }, { target }).catch(() => undefined);

    const offer = room.makeAction<any, boolean>("offer", {
      kind: "request",
      onRequest: async (data, { peerId }) => {
        if (!active()) return false;
        const sanitized = sanitizeOffer(data, peerId);
        if (!sanitized || batchBytes(sanitized.files) > NEARBY_MAX_BATCH_BYTES) return false;
        const ok = await this.handlers.onOffer(sanitized);
        if (!active()) return false;
        if (ok) this.accepted.set(sanitized.id, { from: peerId, files: sanitized.files });
        return ok;
      },
    });
    this.requestOffer = (data, target) => offer.request(data as any, { target, timeoutMs: NEARBY_OFFER_TIMEOUT_MS });

    const file = room.makeAction<ArrayBuffer | Blob>("file", {
      // Refuse bytes nobody accepted, or larger than what was announced.
      onReceive: ({ peerId, metadata, byteLength }) => {
        if (!active()) return false;
        const meta = (metadata || {}) as { offerId?: string; index?: number };
        const entry = this.accepted.get(String(meta.offerId));
        const announced = entry?.files[Number(meta.index)];
        return !!entry && entry.from === peerId && !!announced && byteLength <= announced.size + 1024;
      },
      onReceiveProgress: (percent, { metadata }) => {
        if (!active()) return;
        const meta = (metadata || {}) as { offerId?: string; index?: number };
        this.handlers.onReceiveProgress(String(meta.offerId), Number(meta.index), percent);
      },
      onMessage: (data, { peerId, metadata }) => {
        if (!active()) return;
        const meta = (metadata || {}) as { offerId?: string; index?: number };
        const entry = this.accepted.get(String(meta.offerId));
        const announced = entry?.files[Number(meta.index)];
        if (!entry || entry.from !== peerId || !announced) return;
        this.handlers.onFile(String(meta.offerId), Number(meta.index), new File([data as ArrayBuffer], announced.name, { type: announced.type }));
      },
    });
    this.sendFile = (data, target, metadata, onProgress) =>
      file.send(data, { target, metadata, onProgress: progress => onProgress(progress) });

    room.onPeerJoin = peerId => {
      if (!active()) return;
      this.handlers.onError("");
      if (!this.names[peerId]) this.names[peerId] = NEARBY_UNNAMED_PEER;
      this.handlers.onPeers({ ...this.names });
      void this.sendHello?.(false, peerId);
    };
    room.onPeerLeave = peerId => {
      if (!active()) return;
      delete this.names[peerId];
      this.handlers.onPeers({ ...this.names });
    };
    this.helloTimer = setInterval(() => {
      for (const [peerId, name] of Object.entries(this.names)) {
        if (name === NEARBY_UNNAMED_PEER) void this.sendHello?.(false, peerId);
      }
    }, HELLO_RETRY_MS);
  }

  /** Ask the peer first; resolves false if declined or unanswered. */
  async send(peerId: string, files: File[], onProgress: (index: number, percent: number) => void) {
    if (!this.requestOffer || !this.sendFile) throw new Error("nearby_not_joined");
    if (batchBytes(files) > NEARBY_MAX_BATCH_BYTES) throw new Error("nearby_batch_too_large");
    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
    const accepted = await this.requestOffer({
      id, files: files.map(file => ({ name: file.name, size: file.size, type: file.type || "application/octet-stream" })),
    }, peerId).catch(() => false);
    if (!accepted) return false;
    for (let index = 0; index < files.length; index++) {
      await this.sendFile(files[index], peerId, { offerId: id, index }, percent => onProgress(index, percent));
    }
    return true;
  }

  /** WebRTC state per joined peer, for the diagnostics panel. */
  peerConnections(): Record<string, string> {
    const peers = this.room?.getPeers() || {};
    return Object.fromEntries(Object.entries(peers).map(([id, pc]) => [id, pc?.connectionState || "unknown"]));
  }

  negotiations() {
    return this.rtcDiagnostics?.snapshots() || [];
  }

  /** Fresh negotiation without reconnecting healthy shared relay sockets. */
  async restart() {
    const key = this.key;
    if (!key) return;
    const generation = this.generation + 1;
    await this.leave();
    // A simultaneous logout/account switch invalidates this restart.
    if (generation !== this.generation) return;
    await this.join(key);
  }

  async leave() {
    this.generation++;
    this.key = null;
    const room = this.room;
    const diagnostics = this.rtcDiagnostics;
    this.rtcDiagnostics = null;
    this.room = null;
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.helloTimer = null;
    this.accepted.clear();
    this.requestOffer = null;
    this.sendFile = null;
    this.sendHello = null;
    for (const peerId of Object.keys(this.names)) delete this.names[peerId];
    if (room) await room.leave().catch(() => undefined);
    diagnostics?.clear();
  }
}
