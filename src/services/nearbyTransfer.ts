import type { Room } from "trystero";
import { DEFAULT_RELAY_URLS } from "@/services/connectionSettings";

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
  /** Resolve true to accept. Called before any file bytes are sent. */
  onOffer: (offer: NearbyOffer) => Promise<boolean>;
  onReceiveProgress: (offerId: string, index: number, percent: number) => void;
  onFile: (offerId: string, index: number, file: File) => void;
};

/** One joined room: device names, offers that must be accepted, then files. */
export class NearbyRoom {
  private room: Room | null = null;
  private readonly names: Record<string, string> = {};
  private readonly accepted = new Map<string, { from: string; files: NearbyFileMeta[] }>();
  private sendHello: ((name: string, target?: string) => Promise<void>) | null = null;
  private requestOffer: ((offer: Omit<NearbyOffer, "from">, target: string) => Promise<boolean>) | null = null;
  private sendFile: ((data: Blob, target: string, metadata: { offerId: string; index: number }, onProgress: (percent: number) => void) => Promise<void>) | null = null;

  constructor(private readonly deviceName: string, private readonly handlers: NearbyRoomHandlers) {}

  async join(key: NearbyRoomKey) {
    const { joinRoom } = await import("trystero");
    const room = joinRoom({
      appId: NEARBY_APP_ID,
      password: key.password,
      maxReceiveBytes: NEARBY_MAX_BATCH_BYTES,
      relayConfig: { urls: [...DEFAULT_RELAY_URLS], redundancy: DEFAULT_RELAY_URLS.length },
      rtcConfig: { iceServers: ICE_SERVERS },
    }, key.roomId);
    this.room = room;

    const hello = room.makeAction<string>("hello", {
      onMessage: (name, { peerId }) => {
        this.names[peerId] = String(name || "附近的设备").slice(0, 40);
        this.handlers.onPeers({ ...this.names });
      },
    });
    this.sendHello = (name, target) => hello.send(name, target ? { target } : undefined);

    const offer = room.makeAction<any, boolean>("offer", {
      kind: "request",
      onRequest: async (data, { peerId }) => {
        const sanitized = sanitizeOffer(data, peerId);
        if (!sanitized || batchBytes(sanitized.files) > NEARBY_MAX_BATCH_BYTES) return false;
        const ok = await this.handlers.onOffer(sanitized);
        if (ok) this.accepted.set(sanitized.id, { from: peerId, files: sanitized.files });
        return ok;
      },
    });
    this.requestOffer = (data, target) => offer.request(data as any, { target, timeoutMs: NEARBY_OFFER_TIMEOUT_MS });

    const file = room.makeAction<ArrayBuffer | Blob>("file", {
      // Refuse bytes nobody accepted, or larger than what was announced.
      onReceive: ({ peerId, metadata, byteLength }) => {
        const meta = (metadata || {}) as { offerId?: string; index?: number };
        const entry = this.accepted.get(String(meta.offerId));
        const announced = entry?.files[Number(meta.index)];
        return !!entry && entry.from === peerId && !!announced && byteLength <= announced.size + 1024;
      },
      onReceiveProgress: (percent, { metadata }) => {
        const meta = (metadata || {}) as { offerId?: string; index?: number };
        this.handlers.onReceiveProgress(String(meta.offerId), Number(meta.index), percent);
      },
      onMessage: (data, { peerId, metadata }) => {
        const meta = (metadata || {}) as { offerId?: string; index?: number };
        const entry = this.accepted.get(String(meta.offerId));
        const announced = entry?.files[Number(meta.index)];
        if (!entry || entry.from !== peerId || !announced) return;
        this.handlers.onFile(String(meta.offerId), Number(meta.index), new File([data as ArrayBuffer], announced.name, { type: announced.type }));
      },
    });
    this.sendFile = (data, target, metadata, onProgress) =>
      file.send(data, { target, metadata, onProgress: progress => onProgress(progress) });

    room.onPeerJoin = peerId => { void this.sendHello?.(this.deviceName, peerId); };
    room.onPeerLeave = peerId => {
      delete this.names[peerId];
      this.handlers.onPeers({ ...this.names });
    };
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

  async leave() {
    const room = this.room;
    this.room = null;
    this.accepted.clear();
    if (room) await room.leave().catch(() => undefined);
  }
}
