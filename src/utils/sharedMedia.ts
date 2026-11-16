import type { InboxItem } from "@/nostr/messaging/messageViewModel";
import { hasDisappearingMarker } from "@/nostr/messaging/disappearingMessages";
import { parseFriendRecommendation } from "@/nostr/messaging/friendRecommendation";
import { parseLocationShare } from "@/nostr/messaging/locationShare";
import { parsePrivateFileMessage, type PrivateFileMedia } from "@/nostr/messaging/privateFile";
import { parsePrivateAudioMessage, parsePrivateVideoMessage, type PrivateVideoMedia } from "@/nostr/messaging/privateMedia";
import { extractImageUrls } from "@/utils/extractImageUrls";
import { linkHost, splitLinks } from "@/utils/links";

type Base = { key: string; id: string; created_at: number; own: boolean };
export type SharedImage = Base & { markdown: string };
export type SharedVideo = Base & { media: PrivateVideoMedia };
export type SharedFile = Base & { media: PrivateFileMedia };
export type SharedLink = Base & { url: string; host: string };
export type SharedMediaItems = {
  images: SharedImage[];
  videos: SharedVideo[];
  files: SharedFile[];
  links: SharedLink[];
};

const MARKDOWN_IMAGE = /!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/gi;

/**
 * Sort one conversation's messages into the 图片 / 视频 / 文件 / 链接 tabs.
 * Burn-after-reading messages never appear here, opened or not.
 */
export function collectSharedMedia(messages: readonly InboxItem[], accountPubkey: string): SharedMediaItems {
  const result: SharedMediaItems = { images: [], videos: [], files: [], links: [] };
  const account = accountPubkey.toLowerCase();
  for (const message of messages) {
    if (!message.content || hasDisappearingMarker(message.tags) || message.id.startsWith("local:")) continue;
    const base = { id: message.id, created_at: message.created_at, own: message.pubkey.toLowerCase() === account };
    const video = parsePrivateVideoMessage(message.content);
    if (video) {
      result.videos.push({ ...base, key: message.id, media: video.media });
      continue;
    }
    const file = parsePrivateFileMessage(message.content);
    if (file) {
      result.files.push({ ...base, key: message.id, media: file.media });
      continue;
    }
    if (parsePrivateAudioMessage(message.content) || parseFriendRecommendation(message.content) || parseLocationShare(message.content)) continue;
    extractImageUrls(message.content).forEach((url, index) => {
      result.images.push({ ...base, key: `${message.id}:${index}`, markdown: `![](${url})` });
    });
    const text = message.content.replace(MARKDOWN_IMAGE, " ");
    const seen = new Set<string>();
    for (const segment of splitLinks(text)) {
      if (segment.type !== "link" || seen.has(segment.url)) continue;
      seen.add(segment.url);
      result.links.push({ ...base, key: `${message.id}:${segment.url}`, url: segment.url, host: linkHost(segment.url) });
    }
  }
  return result;
}
