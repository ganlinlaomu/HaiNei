import type { CanonicalMessage } from "./protocol";

export const FRIENDSHIP_LABEL = "hainei-friendship";
export type FriendshipAction = "request" | "accept" | "reject" | "remove" | "cancel";

export function friendshipTags(action: FriendshipAction): string[][] {
  return [["l", FRIENDSHIP_LABEL], ["t", action]];
}

export function isFriendshipControlMessage(message: CanonicalMessage): boolean {
  return message.protocol === "nip17"
    && message.tags.some(tag => tag[0] === "l" && tag[1] === FRIENDSHIP_LABEL)
    && message.tags.some(tag => tag[0] === "t" && ["request", "accept", "reject", "remove", "cancel"].includes(tag[1]));
}

export type FriendshipControl = { action: FriendshipAction; timestamp: number; requestId?: string };

export function decodeFriendshipControl(message: CanonicalMessage): FriendshipControl | null {
  if (!isFriendshipControlMessage(message) || !message.plaintext) return null;
  try {
    const action = message.tags.find(tag => tag[0] === "t")?.[1] as FriendshipAction | undefined;
    const payload = JSON.parse(message.plaintext);
    const expectedType = `friend_${action}`;
    if (!action || payload?.type !== expectedType || payload?.from?.toLowerCase() !== message.senderPubkey.toLowerCase()) return null;
    if (!Number.isFinite(payload.timestamp)) return null;
    const requestId = typeof payload.requestId === "string" && payload.requestId.trim()
      ? payload.requestId.trim()
      : undefined;
    return { action, timestamp: Number(payload.timestamp), requestId };
  } catch {
    return null;
  }
}
