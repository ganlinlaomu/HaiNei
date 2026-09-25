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
