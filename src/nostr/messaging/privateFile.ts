import { bytesToBase64, base64ToBytes } from "@/nostr/crypto";
import { hasOnlyObjectKeys, safeMediaUrl } from "@/utils/mediaSafety";

/** Upload ceiling of the media Worker (MAX_FILE_SIZE_BYTES), less the AES-GCM tag. */
export const MAX_DM_FILE_BYTES = 25 * 1024 * 1024 - 16;
export const MAX_DM_FILE_NAME_LENGTH = 120;
const FILE_REF_PREFIX = "blossom+aesgcm+file:";
const GENERIC_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

export type EncryptedFileMetadata = {
  v: 1;
  url: string;
  mime: string;
  alg: "AES-GCM";
  iv: string;
  key: string;
  size: number;
};

export type PrivateFileMedia = {
  encryptedRef: string;
  name: string;
  mime: string;
  size: number;
};

export type PrivateFileMessage = {
  type: "file";
  media: PrivateFileMedia;
};

/** Keep only the base name, without control or bidi characters. */
export function sanitizeDmFileName(raw: unknown) {
  const base = String(raw ?? "").split(/[\\/]/).pop() || "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "").trim();
  const name = cleaned.replace(/^\.+$/, "") || "文件";
  if (name.length <= MAX_DM_FILE_NAME_LENGTH) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
  return `${name.slice(0, MAX_DM_FILE_NAME_LENGTH - ext.length - 1)}…${ext}`;
}

export function normalizeDmFileMime(raw: unknown) {
  const mime = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return GENERIC_MIME.test(mime) ? mime : "application/octet-stream";
}

function validKeyMaterial(key: unknown, iv: unknown) {
  try {
    return typeof key === "string" && typeof iv === "string" && key.length <= 48 && iv.length <= 20
      && base64ToBytes(key).length === 32 && base64ToBytes(iv).length === 12;
  } catch {
    return false;
  }
}

function validSize(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DM_FILE_BYTES;
}

export function encodeEncryptedFileRef(metadata: EncryptedFileMetadata) {
  return `${FILE_REF_PREFIX}${bytesToBase64(new TextEncoder().encode(JSON.stringify(metadata)))}`;
}

export function decodeEncryptedFileRef(ref: unknown): EncryptedFileMetadata | null {
  if (typeof ref !== "string" || ref.length > 16384 || !ref.startsWith(FILE_REF_PREFIX)) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(base64ToBytes(ref.slice(FILE_REF_PREFIX.length)))) as EncryptedFileMetadata;
    if (value?.v !== 1
      || !hasOnlyObjectKeys(value, ["v", "url", "mime", "alg", "iv", "key", "size"])
      || !safeMediaUrl(value.url)
      || value.alg !== "AES-GCM"
      || !GENERIC_MIME.test(value.mime)
      || !validKeyMaterial(value.key, value.iv)
      || !validSize(value.size)) return null;
    return value;
  } catch {
    return null;
  }
}

export function normalizePrivateFileMedia(value: unknown): PrivateFileMedia | null {
  const media = value as Partial<PrivateFileMedia> | null;
  if (!media
    || !hasOnlyObjectKeys(media, ["encryptedRef", "name", "mime", "size"])
    || !decodeEncryptedFileRef(media.encryptedRef)
    || typeof media.name !== "string"
    || typeof media.mime !== "string"
    || !validSize(media.size)) return null;
  return {
    encryptedRef: media.encryptedRef as string,
    name: sanitizeDmFileName(media.name),
    mime: normalizeDmFileMime(media.mime),
    size: media.size as number,
  };
}

export function serializePrivateFileMessage(media: PrivateFileMedia) {
  const normalized = normalizePrivateFileMedia(media);
  if (!normalized) throw new Error("无效的文件消息");
  return JSON.stringify({ type: "file", media: normalized } satisfies PrivateFileMessage);
}

export function parsePrivateFileMessage(content: string): PrivateFileMessage | null {
  if (!content || content[0] !== "{") return null;
  try {
    const value = JSON.parse(content) as Partial<PrivateFileMessage> | null;
    if (!value || value.type !== "file") return null;
    const media = normalizePrivateFileMedia(value.media);
    return media ? { type: "file", media } : null;
  } catch {
    return null;
  }
}

export function formatDmFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A short label for the card icon: the extension, or the MIME family. */
export function dmFileBadge(name: string, mime: string) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
  if (ext && ext.length <= 4 && /^[A-Z0-9]+$/.test(ext)) return ext;
  const family = mime.split("/")[0];
  return family === "application" || !family ? "FILE" : family.toUpperCase().slice(0, 4);
}
