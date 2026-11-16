import { describe, expect, it } from "vitest";
import { collectSharedMedia } from "@/utils/sharedMedia";
import { encodeEncryptedFileRef, serializePrivateFileMessage } from "@/nostr/messaging/privateFile";
import { serializePrivateAudioMessage, serializePrivateVideoMessage } from "@/nostr/messaging/privateMedia";
import { DISAPPEARING_DM_TYPE } from "@/nostr/messaging/disappearingMessages";
import { bytesToBase64 } from "@/nostr/crypto";
import type { InboxItem } from "@/nostr/messaging/messageViewModel";

const ME = "a".repeat(64);
const PEER = "b".repeat(64);
let seq = 0;
function message(content: string, extra: Partial<InboxItem> = {}): InboxItem {
  seq += 1;
  return { id: String(seq).padStart(64, "0"), pubkey: PEER, created_at: 1_800_000_000 + seq, content, tags: [["t", "hainei-dm"]], ...extra };
}
const fileRef = encodeEncryptedFileRef({
  v: 1, url: "https://media.example/f", mime: "application/pdf", alg: "AES-GCM",
  iv: bytesToBase64(new Uint8Array(12)), key: bytesToBase64(new Uint8Array(32)), size: 10,
});

describe("shared media collection", () => {
  it("sorts a conversation into images, videos, files and links", () => {
    const items = [
      message("看这个 ![](blossom+aesgcm:abc) https://tenki.jp/forecast", { pubkey: ME }),
      message(serializePrivateVideoMessage({ encryptedRef: "blossom+aesgcm+video:x", mime: "video/mp4", size: 5 })),
      message(serializePrivateFileMessage({ encryptedRef: fileRef, name: "a.pdf", mime: "application/pdf", size: 10 })),
      message(serializePrivateAudioMessage({ encryptedRef: "blossom+aesgcm:voice", mime: "audio/mp4", duration: 2, size: 9 })),
      message("https://example.com/a https://example.com/a"),
    ];
    const result = collectSharedMedia(items, ME);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ markdown: "![](blossom+aesgcm:abc)", own: true });
    expect(result.videos).toHaveLength(1);
    expect(result.files.map(item => item.media.name)).toEqual(["a.pdf"]);
    expect(result.links.map(item => item.host)).toEqual(["tenki.jp", "example.com"]);
  });

  it("never lists burn-after-reading or unsent messages", () => {
    const result = collectSharedMedia([
      message("![](blossom+aesgcm:secret) https://secret.example", { tags: [["t", "hainei-dm"], ["t", DISAPPEARING_DM_TYPE]] }),
      message("![](blossom+aesgcm:pending)", { id: "local:1" }),
    ], ME);
    expect(result).toEqual({ images: [], videos: [], files: [], links: [] });
  });
});
