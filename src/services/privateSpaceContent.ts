import type { PrivateSpaceAttachment, PrivateSpaceRecord, PrivateSpaceSource } from "@/db/dexie";
import { extractImageUrls } from "@/utils/extractImageUrls";
import { extractVideoData, getVideoUrlRemovalPatterns } from "@/utils/videoUtils";

const HEX_ID = /^[0-9a-f]{64}$/i;
const URL_SAFE = /^(?:https?:\/\/|blossom\+aesgcm:)/i;
const MAX_ATTACHMENTS = 12;
const MAX_ATTACHMENT_BYTES = 24_000;
const videos = getVideoUrlRemovalPatterns();
const MARKDOWN_IMAGE = /!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/gi;
const PLAIN_IMAGE = /https?:\/\/[^\s)]+?\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s)]*)?/gi;

/** Content extracted from a renderable post; not the Nostr event or NIP-17 wrapper. */
export function extractPrivateSpaceContent(content: string, includeMedia = true):
  { text: string; attachments: PrivateSpaceAttachment[] } {
  const attachments: PrivateSpaceAttachment[] = [];
  if (includeMedia) {
    for (const url of extractImageUrls(content).slice(0, MAX_ATTACHMENTS)) {
      if (URL_SAFE.test(url)) attachments.push({ kind: "image", url });
    }
    const video = extractVideoData(content);
    if (video?.url && URL_SAFE.test(video.url) && attachments.length < MAX_ATTACHMENTS) {
      attachments.push({ kind: "video", url: video.url });
    }
  }
  // Match the visible feed's filtering rules; never include transport metadata in the editor body.
  const text = content
    .replace(MARKDOWN_IMAGE, "")
    .replace(PLAIN_IMAGE, "")
    .replace(videos.videoDataPattern, "")
    .replace(videos.youtubePattern, "")
    .replace(videos.vimeoPattern, "")
    .replace(videos.directVideoPattern, "")
    .replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, attachments: validatePrivateSpaceAttachments(attachments) };
}

export function validatePrivateSpaceSource(value: unknown): PrivateSpaceSource | undefined {
  if (value === undefined) return undefined;
  const source = value as Partial<PrivateSpaceSource> | null;
  if (!source || typeof source !== "object" ||
    (source.kind !== "post" && source.kind !== "dm") ||
    typeof source.messageId !== "string" || !HEX_ID.test(source.messageId) ||
    typeof source.author !== "string" || source.author.length > 200 ||
    typeof source.date !== "string" || source.date.length > 50 ||
    (source.authorPubkey !== undefined && (typeof source.authorPubkey !== "string" || !HEX_ID.test(source.authorPubkey))) ||
    (source.kind === "dm" && (typeof source.peerPubkey !== "string" || !HEX_ID.test(source.peerPubkey))) ||
    (source.peerPubkey !== undefined && (typeof source.peerPubkey !== "string" || !HEX_ID.test(source.peerPubkey))))
    throw new Error("invalid_private_space_source");
  return {
    kind: source.kind, messageId: source.messageId.toLowerCase(), author: source.author, date: source.date,
    ...(source.authorPubkey ? { authorPubkey: source.authorPubkey.toLowerCase() } : {}),
    ...(source.peerPubkey ? { peerPubkey: source.peerPubkey.toLowerCase() } : {}),
  };
}
export function validatePrivateSpaceAttachments(value: unknown): PrivateSpaceAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS)
    throw new Error("invalid_private_space_attachments");
  const seen = new Set<string>();
  const attachments = value.map((raw: unknown) => {
    const item = raw as Partial<PrivateSpaceAttachment> | null;
    if (!item || typeof item !== "object" ||
      (item.kind !== "image" && item.kind !== "video") ||
      typeof item.url !== "string" || !URL_SAFE.test(item.url) || item.url.length > 10_000 ||
      seen.has(item.kind + ":" + item.url))
      throw new Error("invalid_private_space_attachment");
    seen.add(item.kind + ":" + item.url);
    return { kind: item.kind, url: item.url };
  });
  if (new TextEncoder().encode(JSON.stringify(attachments)).byteLength > MAX_ATTACHMENT_BYTES)
    throw new Error("private_space_attachments_too_large");
  return attachments;
}

const LEGACY_POST = "来源：海内动态";
const LEGACY_DM = "来源：海内普通私信（仅文字）";
function legacyField(lines: string[], label: string): string {
  const line = lines.find(entry => entry.startsWith(label + "："));
  return line?.slice(label.length + 1).trim() || "";
}
/** Legacy PR3-A header recognition is opt-in and strict; arbitrary user text is not rewritten. */
export function parseLegacyPrivateSpaceBody(body: string):
  { text: string; source: PrivateSpaceSource; attachments: PrivateSpaceAttachment[] } | null {
  const [header, ...parts] = body.split("\n\n");
  const lines = header?.split("\n") || [];
  if (parts.length === 0 || (lines[0] !== LEGACY_POST && lines[0] !== LEGACY_DM)) return null;
  const kind = lines[0] === LEGACY_POST ? "post" : "dm";
  const messageId = legacyField(lines, "消息 ID");
  const authorPubkey = legacyField(lines, kind === "post" ? "作者公钥" : "发送者公钥");
  const peerPubkey = legacyField(lines, "对话对象");
  const date = legacyField(lines, kind === "post" ? "发布时间" : "发送时间");
  const author = legacyField(lines, kind === "post" ? "作者" : "发送者");
  if (!HEX_ID.test(messageId) || !HEX_ID.test(authorPubkey) ||
    (kind === "dm" && !HEX_ID.test(peerPubkey))) return null;
  const source = validatePrivateSpaceSource({
    kind, messageId, authorPubkey, author, date,
    ...(kind === "dm" ? { peerPubkey } : {}),
  });
  if (!source) return null;
  const extracted = extractPrivateSpaceContent(parts.join("\n\n"), kind === "post");
  return { text: extracted.text === "（仅保存了原动态的引用信息）" ? "" : extracted.text,
    source, attachments: extracted.attachments };
}

/** Read-only projection: legacy notes are never rewritten merely by viewing them. */
export function privateSpaceDisplay(record: Pick<PrivateSpaceRecord, "body" | "source" | "attachments">):
  { text: string; source?: PrivateSpaceSource; attachments: PrivateSpaceAttachment[] } {
  if (record.source) return {
    text: record.body,
    source: validatePrivateSpaceSource(record.source),
    attachments: validatePrivateSpaceAttachments(record.attachments),
  };
  const old = parseLegacyPrivateSpaceBody(record.body);
  return old || { text: record.body, attachments: [] };
}

export function privateSpaceTitle(text: string, fallback: string): string {
  const first = text.split("\n").find(line => line.trim())?.trim();
  return (first && first.length > 0 ? first.slice(0, 80) : fallback).slice(0, 120);
}
