import type { CanonicalMessage } from "./protocol";
import { parsePrivateAudioMessage } from "./privateMedia";
import { parseFriendRecommendation } from "./friendRecommendation";

import { isDirectMessageTags } from "./messageRouting";
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

export function directMessagePreview(content: string) {
  if (parseFriendRecommendation(content)) return "[好友推荐]";
  if (parsePrivateAudioMessage(content)) return "[语音]";
  const hasImage = /!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/i.test(content);
  const text = content
    .replace(/!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || (hasImage ? "[图片]" : "");
}
