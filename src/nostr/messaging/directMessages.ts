import type { CanonicalMessage } from "./protocol";
import { parsePrivateAudioMessage, parsePrivateVideoMessage } from "./privateMedia";
import { parsePrivateFileMessage } from "./privateFile";
import { parseFriendRecommendation } from "./friendRecommendation";
import { parseLocationShare } from "./locationShare";

import { isDirectMessageTags } from "./messageRouting";
import { memoByContent } from "@/utils/memoByContent";
export { DIRECT_MESSAGE_TYPE, isDirectMessageTags } from "./messageRouting";

export function canStartDirectMessage(
  accountPubkey: string,
  peerPubkey: string,
  isAccepted: (pubkey: string) => boolean,
) {
  const account = accountPubkey.trim().toLowerCase();
  const peer = peerPubkey.trim().toLowerCase();
  return !!account && !!peer && peer !== account && isAccepted(peer);
}

export function isDirectMessage(message: Pick<CanonicalMessage, "tags">) {
  return isDirectMessageTags(message.tags);
}

export function directMessagePeer(
  message: Pick<CanonicalMessage, "senderPubkey" | "recipientPubkeys">,
  accountPubkey: string,
) {
  const account = accountPubkey.toLowerCase();
  const sender = message.senderPubkey.toLowerCase();
  if (sender !== account) return sender;
  return message.recipientPubkeys.map(value => value.toLowerCase()).find(value => value !== account) || "";
}

function computeDirectMessagePreview(content: string) {
  if (parseFriendRecommendation(content)) return "[好友推荐]";
  if (parseLocationShare(content)) return "[位置]";
  if (parsePrivateAudioMessage(content)) return "[语音]";
  if (parsePrivateVideoMessage(content)) return "[视频]";
  const file = parsePrivateFileMessage(content);
  if (file) return `[文件] ${file.media.name}`;
  const hasImage = /!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/i.test(content);
  const text = content
    .replace(/!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || (hasImage ? "[图片]" : "");
}

/**
 * The one-line preview of a message (conversation list, search, chat text).
 * It runs five content parsers and two regexes, and the chat calls it several
 * times per rendered row on every render, so results are cached by content.
 */
export const directMessagePreview = memoByContent(computeDirectMessagePreview);

