export type PrivateAudioMedia = {
  encryptedRef: string;
  mime: string;
  duration: number;
  size: number;
};

export type PrivateAudioMessage = {
  type: "audio";
  media: PrivateAudioMedia;
};

function finiteNumber(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function normalizePrivateAudioMedia(value: unknown): PrivateAudioMedia | null {
  const media = value as Partial<PrivateAudioMedia> | null;
  if (!media
    || typeof media.encryptedRef !== "string"
    || !media.encryptedRef.startsWith("blossom+aesgcm:")
    || typeof media.mime !== "string"
    || !media.mime.toLowerCase().startsWith("audio/")
    || !finiteNumber(media.duration, 0, 300)
    || !finiteNumber(media.size, 0)) return null;
  return {
    encryptedRef: media.encryptedRef,
    mime: media.mime,
    duration: media.duration as number,
    size: media.size as number,
  };
}

export function serializePrivateAudioMessage(media: PrivateAudioMedia) {
  const normalized = normalizePrivateAudioMedia(media);
  if (!normalized) throw new Error("无效的语音消息");
  return JSON.stringify({ type: "audio", media: normalized } satisfies PrivateAudioMessage);
}

export function parsePrivateAudioMessage(content: string): PrivateAudioMessage | null {
  try {
    const value = JSON.parse(content) as Partial<PrivateAudioMessage> | null;
    if (!value || value.type !== "audio") return null;
    const media = normalizePrivateAudioMedia(value.media);
    return media ? { type: "audio", media } : null;
  } catch {
    return null;
  }
}

/** Upload ceiling of the media Worker (MAX_FILE_SIZE_BYTES), less the AES-GCM tag. */
export const MAX_DM_VIDEO_BYTES = 25 * 1024 * 1024 - 16;
/** Largest picked video we try to compress below MAX_DM_VIDEO_BYTES. */
export const MAX_DM_VIDEO_SOURCE_BYTES = 1024 * 1024 * 1024;

export type PrivateVideoMedia = {
  encryptedRef: string;
  mime: string;
  size: number;
};

export type PrivateVideoMessage = {
  type: "video";
  media: PrivateVideoMedia;
};

export function normalizePrivateVideoMedia(value: unknown): PrivateVideoMedia | null {
  const media = value as Partial<PrivateVideoMedia> | null;
  if (!media
    || typeof media.encryptedRef !== "string"
    || !media.encryptedRef.startsWith("blossom+aesgcm+video:")
    || typeof media.mime !== "string"
    || !media.mime.toLowerCase().startsWith("video/")
    || !finiteNumber(media.size, 0, MAX_DM_VIDEO_BYTES)) return null;
  return { encryptedRef: media.encryptedRef, mime: media.mime, size: media.size as number };
}

export function serializePrivateVideoMessage(media: PrivateVideoMedia) {
  const normalized = normalizePrivateVideoMedia(media);
  if (!normalized) throw new Error("无效的视频消息");
  return JSON.stringify({ type: "video", media: normalized } satisfies PrivateVideoMessage);
}

export function parsePrivateVideoMessage(content: string): PrivateVideoMessage | null {
  try {
    const value = JSON.parse(content) as Partial<PrivateVideoMessage> | null;
    if (!value || value.type !== "video") return null;
    const media = normalizePrivateVideoMedia(value.media);
    return media ? { type: "video", media } : null;
  } catch {
    return null;
  }
}
