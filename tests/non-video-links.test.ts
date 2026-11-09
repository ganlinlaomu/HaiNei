// Before 0.1.194 the post editor turned every pasted https link into a
// [video:{...}] block, so a Google Maps link showed as a broken video player.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractVideoData, parseVideoUrl, unwrapNonVideoBlocks } from "@/utils/videoUtils";
import { linkCardsFor, stripLinks } from "@/utils/links";
import { encodeEncryptedVideoRef } from "@/utils/encryptedVideoRef";
import { extractPrivateSpaceContent } from "@/services/privateSpaceContent";

const MAP = "https://maps.app.goo.gl/AbCdEfGhIjK123";
const block = (url: string, provider = "External") => `[video:${JSON.stringify({ type: "video", url, provider, embedUrl: url })}]`;
// The post from the bug report: a caption and a map link stored as a video.
const oldPost = `yuri coffee，周四去看看\n${block(MAP)}\n`;

describe("粘贴的普通链接不再当成视频", () => {
  it("地图、网页等链接不是视频", () => {
    expect(parseVideoUrl(MAP)).toBeNull();
    expect(parseVideoUrl("https://www.google.com/maps/place/Tokyo")).toBeNull();
    expect(parseVideoUrl("https://tenki.jp/forecast/3")).toBeNull();
    expect(parseVideoUrl("https://www.amazon.co.jp/dp/B000")).toBeNull();
  });

  it("真正的视频链接照旧识别", () => {
    expect(parseVideoUrl("https://youtu.be/dQw4w9WgXcQ")?.provider).toBe("YouTube");
    expect(parseVideoUrl("https://vimeo.com/123456")?.provider).toBe("Vimeo");
    expect(parseVideoUrl("https://cdn.example.com/clip.mp4")?.provider).toBe("Direct");
  });
});

describe("已经存成视频的普通链接", () => {
  it("显示时还原成链接，不再出现视频播放器", () => {
    expect(extractVideoData(oldPost)).toBeNull();
    expect(unwrapNonVideoBlocks(oldPost)).toBe(`yuri coffee，周四去看看\n${MAP}\n`);
  });

  it("还原后显示成地图卡片，正文只剩文字", () => {
    const text = unwrapNonVideoBlocks(oldPost).trim();
    const cards = linkCardsFor(text);
    expect(cards.map(card => [card.kind, card.site])).toEqual([["maps", "Google 地图"]]);
    expect(stripLinks(text, new Set(cards.map(card => card.url)))).toBe("yuri coffee，周四去看看");
  });

  it("真正的视频块不动", () => {
    const youtube = block("https://youtu.be/dQw4w9WgXcQ", "YouTube");
    const direct = block("https://cdn.example.com/clip.mp4", "Direct");
    const encrypted = block(encodeEncryptedVideoRef({
      v: 1, url: "https://media.example.com/" + "a".repeat(64), mime: "video/mp4", alg: "AES-GCM",
      iv: "AAAAAAAAAAAAAAAA", key: "A".repeat(43) + "=", size: 10,
    }), "Encrypted");
    for (const content of [youtube, direct, encrypted]) expect(unwrapNonVideoBlocks(content)).toBe(content);
  });

  it("不安全或格式坏掉的块不会被还原成链接", () => {
    for (const content of [block("javascript:alert(1)"), block("http://example.com/x"), "[video:{not json}]"]) {
      expect(unwrapNonVideoBlocks(content)).toBe(content);
    }
  });

  it("摘录到私人空间时保留这个链接，不当成视频附件", () => {
    const { text, attachments } = extractPrivateSpaceContent(oldPost);
    expect(text).toBe(`yuri coffee，周四去看看\n${MAP}`);
    expect(attachments).toEqual([]);
  });

  it("帖子、通知都先还原再显示", () => {
    expect(readFileSync("src/components/PostCard.vue", "utf8")).toContain('unwrapNonVideoBlocks(props.message.content || "")');
    expect(readFileSync("src/views/Notifications.vue", "utf8")).toContain("unwrapNonVideoBlocks(text)");
  });
});
