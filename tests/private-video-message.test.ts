import { describe, expect, it } from "vitest";
import { MAX_DM_VIDEO_BYTES, parsePrivateVideoMessage, serializePrivateVideoMessage } from "@/nostr/messaging/privateMedia";
import { directMessagePreview } from "@/nostr/messaging/directMessages";

const media = { encryptedRef: "blossom+aesgcm+video:abc", mime: "video/mp4", size: 1234 };

describe("private video messages", () => {
  it("round-trips and previews as [视频]", () => {
    const content = serializePrivateVideoMessage(media);
    expect(parsePrivateVideoMessage(content)).toEqual({ type: "video", media });
    expect(directMessagePreview(content)).toBe("[视频]");
  });

  it("rejects refs, types and sizes a peer should not be able to send", () => {
    const parse = (value: unknown) => parsePrivateVideoMessage(JSON.stringify({ type: "video", media: value }));
    expect(parse({ ...media, encryptedRef: "https://example.com/v.mp4" })).toBeNull();
    expect(parse({ ...media, encryptedRef: "blossom+aesgcm:image" })).toBeNull();
    expect(parse({ ...media, mime: "text/html" })).toBeNull();
    expect(parse({ ...media, size: MAX_DM_VIDEO_BYTES + 1 })).toBeNull();
    expect(parsePrivateVideoMessage("普通文字")).toBeNull();
    expect(() => serializePrivateVideoMessage({ ...media, mime: "audio/mp4" })).toThrow();
  });
});
