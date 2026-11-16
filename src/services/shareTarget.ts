/**
 * Content shared into HaiNei from another app (系统分享 / Web Share Target).
 * The service worker stores the POSTed form in SHARE_INBOX_CACHE; the share
 * page picks a friend, and that chat takes it into the composer, unsent.
 * Names and URLs must match public/service-worker.js.
 */
export const SHARE_INBOX_CACHE = "hainei-share-inbox-v1";
const SHARE_META_PATH = "/__hainei_share__/meta";
const SHARE_FILE_PATH_PREFIX = "/__hainei_share__/file/";
/** Shared content waits this long for a friend to be picked. */
export const SHARE_TTL_MS = 60 * 60 * 1000;

export type PendingShareFile = { key: string; name: string; type: string; size: number };
export type PendingShareMeta = {
  v: 1;
  createdAt: number;
  text: string;
  files: PendingShareFile[];
  /** Set once a friend is picked; only that chat may take the share. */
  peer?: string;
};
export type PendingShare = { text: string; files: File[] };

function shareCachesAvailable() {
  return typeof caches !== "undefined" && typeof caches.open === "function";
}

function metaUrl() {
  return new URL(SHARE_META_PATH, location.origin).href;
}

function isShareFileKey(key: unknown, origin: string): key is string {
  if (typeof key !== "string") return false;
  try {
    const url = new URL(key);
    return url.origin === origin && url.pathname.startsWith(SHARE_FILE_PATH_PREFIX);
  } catch {
    return false;
  }
}

export function normalizePendingShareMeta(
  value: unknown,
  now = Date.now(),
  origin = typeof location === "undefined" ? "" : location.origin,
): PendingShareMeta | null {
  const meta = value as Partial<PendingShareMeta> | null;
  if (!meta || meta.v !== 1 || typeof meta.createdAt !== "number" || !Number.isFinite(meta.createdAt)) return null;
  if (now - meta.createdAt > SHARE_TTL_MS || meta.createdAt - now > 60_000) return null;
  const files = Array.isArray(meta.files) ? meta.files.filter(file => file
    && isShareFileKey(file.key, origin)
    && typeof file.name === "string"
    && typeof file.type === "string"
    && Number.isSafeInteger(file.size) && file.size > 0).slice(0, 9) : [];
  const text = typeof meta.text === "string" ? meta.text.slice(0, 20_000) : "";
  if (!text.trim() && !files.length) return null;
  return {
    v: 1,
    createdAt: meta.createdAt,
    text,
    files: files.map(file => ({ key: file.key, name: file.name.slice(0, 200), type: file.type.slice(0, 120), size: file.size })),
    ...(typeof meta.peer === "string" && /^[0-9a-f]{64}$/.test(meta.peer) ? { peer: meta.peer } : {}),
  };
}

export async function readPendingShare(): Promise<PendingShareMeta | null> {
  if (!shareCachesAvailable()) return null;
  try {
    const cache = await caches.open(SHARE_INBOX_CACHE);
    const response = await cache.match(metaUrl());
    if (!response) return null;
    const meta = normalizePendingShareMeta(await response.json());
    if (!meta) await clearPendingShare();
    return meta;
  } catch {
    return null;
  }
}

export async function clearPendingShare() {
  if (!shareCachesAvailable()) return;
  try {
    await caches.delete(SHARE_INBOX_CACHE);
  } catch {
    // Nothing to clean up.
  }
}

/** Route the pending share to one friend's chat. */
export async function assignPendingShare(peer: string) {
  const meta = await readPendingShare();
  if (!meta) return false;
  const cache = await caches.open(SHARE_INBOX_CACHE);
  await cache.put(metaUrl(), new Response(JSON.stringify({ ...meta, peer: peer.toLowerCase() }), {
    headers: { "Content-Type": "application/json" },
  }));
  return true;
}

/** Take (and delete) the share assigned to this chat, if any. */
export async function takePendingShare(peer: string): Promise<PendingShare | null> {
  const meta = await readPendingShare();
  if (!meta || meta.peer !== peer.toLowerCase()) return null;
  const cache = await caches.open(SHARE_INBOX_CACHE);
  const files: File[] = [];
  for (const entry of meta.files) {
    const response = await cache.match(entry.key);
    if (!response) continue;
    const blob = await response.blob();
    files.push(new File([blob], entry.name || "文件", { type: entry.type || "" }));
  }
  await clearPendingShare();
  return { text: meta.text, files };
}
