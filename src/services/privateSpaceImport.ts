import type { InboxItem } from "@/nostr/messaging/messageViewModel";
import { isFeedRenderableMessage, isHomeControl } from "@/nostr/messaging/messageViewModel";
import { hasDisappearingMarker, isExpiredDisappearing } from "@/nostr/messaging/disappearingMessages";
import { isDirectMessageTags } from "@/nostr/messaging/directMessages";
import { parsePrivateAudioMessage } from "@/nostr/messaging/privateMedia";
import { parseFriendRecommendation } from "@/nostr/messaging/friendRecommendation";
import { privateSpaceRepository, type PrivateSpaceRepository } from "@/repositories/privateSpaceRepository";

/** No background imports, no remote fetch, and no content read from expired ephemeral messages. */
export type PrivateSpaceImportSession = {
  pkHex: string;
  isUnlocked: boolean;
  sessionGeneration: number;
};
type Source = Pick<InboxItem, "id" | "pubkey" | "created_at" | "content" | "tags" | "outgoing">;
type Imported = { created: boolean; id: string };

const PUBKEY = /^[0-9a-f]{64}$/i;
const MESSAGE_ID = /^[0-9a-f]{64}$/i;
// Limit the serialized NIP-44 envelope as well as the local repository size.
const MAX_SOURCE_BYTES = 50_000;

export function canImportPost(message: Source): boolean {
  return MESSAGE_ID.test(message.id) && PUBKEY.test(message.pubkey)
    && Number.isSafeInteger(message.created_at) && message.created_at > 0
    && typeof message.content === "string"
    && !hasDisappearingMarker(message.tags)
    && (!message.outgoing || message.outgoing.state === "sent")
    && isFeedRenderableMessage(message);
}

export function canImportDirectMessage(
  message: Source,
  account: string,
  peer: string,
  burned = false,
): boolean {
  const owner = account.toLowerCase();
  const conversationPeer = peer.toLowerCase();
  return !burned && PUBKEY.test(owner) && PUBKEY.test(conversationPeer)
    && owner !== conversationPeer
    && MESSAGE_ID.test(message.id)
    && (message.pubkey.toLowerCase() === owner || message.pubkey.toLowerCase() === conversationPeer)
    && Number.isSafeInteger(message.created_at) && message.created_at > 0
    && typeof message.content === "string"
    && isDirectMessageTags(message.tags)
    && !hasDisappearingMarker(message.tags)
    && !isExpiredDisappearing(message.tags)
    && !isHomeControl(message.tags, message.content)
    && !parsePrivateAudioMessage(message.content)
    && !parseFriendRecommendation(message.content)
    && (!message.outgoing || message.outgoing.state === "sent")
    && !!directMessagePlainText(message.content);
}

function directMessagePlainText(content: string) {
  return content.replace(/!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/gi, "").trim();
}
function ensureSession(session: PrivateSpaceImportSession, account: string, generation: number) {
  if (!session.isUnlocked || session.pkHex.toLowerCase() !== account || session.sessionGeneration !== generation)
    throw new Error("private_space_account_changed");
}
async function deterministicImportId(source: string) {
  const bytes = new TextEncoder().encode("hainei-private-space-import-v1:" + source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function validateSize(title: string, body: string) {
  if (title.length > 500 || body.length > 100_000
    || new TextEncoder().encode(JSON.stringify({ title, body })).length > MAX_SOURCE_BYTES)
    throw new Error("private_space_import_too_large");
}
function sourceDate(createdAt: number) {
  return new Date(createdAt * 1000).toISOString();
}
function shortName(name: string, fallback: string) {
  return name.trim().slice(0, 110) || fallback.slice(0, 12);
}

export async function importPostToPrivateSpace(
  session: PrivateSpaceImportSession,
  message: Source,
  authorName = "",
  repository: PrivateSpaceRepository = privateSpaceRepository,
): Promise<Imported> {
  if (!canImportPost(message)) throw new Error("private_space_post_not_importable");
  const account = session.pkHex.toLowerCase();
  const generation = session.sessionGeneration;
  if (!PUBKEY.test(account)) throw new Error("private_space_account_unavailable");
  ensureSession(session, account, generation);
  const title = "动态 · " + shortName(authorName, message.pubkey);
  const body = [
    "来源：海内动态",
    "作者：" + (authorName.trim() || message.pubkey),
    "作者公钥：" + message.pubkey,
    "发布时间：" + sourceDate(message.created_at),
    "消息 ID：" + message.id,
    "",
    message.content.trim() || "（仅保存了原动态的引用信息）",
  ].join("\n");
  validateSize(title, body);
  const id = await deterministicImportId("post:" + message.id.toLowerCase());
  ensureSession(session, account, generation);
  const result = await repository.importNote(account, id, title, body);
  return { created: result.created, id };
}

export async function importDirectMessageToPrivateSpace(
  session: PrivateSpaceImportSession,
  message: Source,
  peer: string,
  displayName = "",
  burned = false,
  repository: PrivateSpaceRepository = privateSpaceRepository,
): Promise<Imported> {
  const account = session.pkHex.toLowerCase();
  const generation = session.sessionGeneration;
  if (!canImportDirectMessage(message, account, peer, burned))
    throw new Error("private_space_dm_not_importable");
  ensureSession(session, account, generation);
  const author = message.pubkey.toLowerCase() === account
    ? "自己" : shortName(displayName, peer);
  const title = "私信 · " + shortName(displayName, peer);
  const body = [
    "来源：海内普通私信（仅文字）",
    "发送者：" + author,
    "发送者公钥：" + message.pubkey,
    "对话对象：" + peer,
    "发送时间：" + sourceDate(message.created_at),
    "消息 ID：" + message.id,
    "",
    directMessagePlainText(message.content),
  ].join("\n");
  validateSize(title, body);
  const id = await deterministicImportId("dm:" + message.id.toLowerCase());
  ensureSession(session, account, generation);
  const result = await repository.importNote(account, id, title, body);
  return { created: result.created, id };
}
