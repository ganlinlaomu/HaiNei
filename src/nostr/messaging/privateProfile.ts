import type { HaiNeiProfile } from "@/db/dexie";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";

export const HAI_NEI_PROFILE_TYPE = "hainei-profile";
export const HAI_NEI_PROFILE_VERSION = 1;
export const HAI_NEI_PROFILE_TAGS = [["t", HAI_NEI_PROFILE_TYPE]];

type HaiNeiProfilePayload = {
  type: typeof HAI_NEI_PROFILE_TYPE;
  version: typeof HAI_NEI_PROFILE_VERSION;
  nickname?: string;
  bio?: string;
  avatar?: string;
  updatedAt: number;
};

function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || undefined;
}

export function decodeHaiNeiProfileMessage(message: CanonicalMessage): HaiNeiProfile | null {
  if (!message.tags.some(tag => tag[0] === "t" && tag[1] === HAI_NEI_PROFILE_TYPE)) return null;
  try {
    const value = JSON.parse(message.plaintext || "") as Partial<HaiNeiProfilePayload>;
    if (value?.type !== HAI_NEI_PROFILE_TYPE || value.version !== HAI_NEI_PROFILE_VERSION) return null;
    if (!Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) <= 0) return null;
    const avatar = cleanText(value.avatar, 16_384);
    if (avatar && !avatar.startsWith("blossom+aesgcm:")) return null;
    return {
      ownerPubkey: message.senderPubkey.toLowerCase(),
      nickname: cleanText(value.nickname, 100),
      bio: cleanText(value.bio, 500),
      avatar,
      updatedAt: Number(value.updatedAt)
    };
  } catch {
    return null;
  }
}

export function isHaiNeiProfileMessage(message: CanonicalMessage) {
  return message.tags.some(tag => tag[0] === "t" && tag[1] === HAI_NEI_PROFILE_TYPE);
}

export function encodeHaiNeiProfilePayload(profile: HaiNeiProfile) {
  return JSON.stringify({
    type: HAI_NEI_PROFILE_TYPE,
    version: HAI_NEI_PROFILE_VERSION,
    nickname: profile.nickname,
    bio: profile.bio,
    avatar: profile.avatar,
    updatedAt: profile.updatedAt
  });
}
