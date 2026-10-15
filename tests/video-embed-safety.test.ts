// A friend's post controls the whole [video:{...}] block. Only its url may be
// trusted as input; provider/embedUrl/thumbnail must be derived locally and
// nothing may yield a non-https executable URL (zero-click XSS in the APK,
// which ships without the Pages CSP).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractVideoData, parseVideoUrl, type VideoData } from "@/utils/videoUtils";
import { encodeEncryptedVideoRef } from "@/utils/encryptedVideoRef";
import { safeVideoEmbed } from "@/utils/videoUtils";

const YT = "dQw4w9WgXcQ";
const block = (value: Record<string, unknown>) => `hi\n[video:${JSON.stringify(value)}]`;

function assertSafe(video: VideoData | null) {
  if (!video) return;
  for (const value of [video.url, video.embedUrl, video.thumbnail]) {
    if (value === undefined) continue;
    expect(value).toMatch(/^(https:\/\/|blossom\+aesgcm\+video:)/);
  }
}

describe("structured [video:{...}] blocks from post content", () => {
  it("never passes through a javascript: embedUrl for a YouTube provider", () => {
    const video = extractVideoData(block({
      type: "video", provider: "YouTube", url: `https://youtu.be/${YT}`, embedUrl: "javascript:alert(document.domain)",
    }));
    assertSafe(video);
    expect(video?.embedUrl).toBe(`https://www.youtube.com/embed/${YT}`);
  });

  it("drops a block whose url is not https or an encrypted reference", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://example.com/a.mp4", "vbscript:x"]) {
      const video = extractVideoData(block({ type: "video", provider: "External", url, embedUrl: url }));
      expect(video).toBeNull();
    }
  });

  it("ignores a forged provider/embedUrl and derives them from the url", () => {
    const video = extractVideoData(block({
      type: "video", provider: "Vimeo", url: "https://cdn.example.com/clip.mp4", embedUrl: "https://evil.example/frame",
    }));
    expect(video).toEqual({ type: "video", url: "https://cdn.example.com/clip.mp4", provider: "Direct", embedUrl: "https://cdn.example.com/clip.mp4" });
  });

  it("keeps the app's own encrypted video posts working", () => {
    const ref = encodeEncryptedVideoRef({
      v: 1, url: "https://media.example.com/" + "a".repeat(64), mime: "video/mp4", alg: "AES-GCM",
      iv: "AAAAAAAAAAAAAAAA", key: "A".repeat(43) + "=", size: 10,
    });
    const video = extractVideoData(block({ type: "video", provider: "Encrypted", url: ref, embedUrl: ref }));
    expect(video?.url).toBe(ref);
    expect(video?.provider).toBe("Encrypted");
  });

  it("keeps legitimate YouTube and Vimeo blocks working", () => {
    expect(extractVideoData(block({ type: "video", provider: "YouTube", url: `https://www.youtube.com/watch?v=${YT}` })))
      .toMatchObject({ provider: "YouTube", embedUrl: `https://www.youtube.com/embed/${YT}` });
    expect(extractVideoData(block({ type: "video", provider: "Vimeo", url: "https://vimeo.com/123456" })))
      .toMatchObject({ provider: "Vimeo", embedUrl: "https://player.vimeo.com/video/123456" });
  });
});

describe("pasted / plain video URLs", () => {
  it("does not turn non-https schemes into a playable video", () => {
    expect(parseVideoUrl("javascript:alert(1)")).toBeNull();
    expect(parseVideoUrl("data:text/html,x")).toBeNull();
    assertSafe(parseVideoUrl(`javascript://youtu.be/${YT}`));
  });
});

describe("VideoPlayer render-time guard", () => {
  it("only allows the two embed origins in iframes and https elsewhere", () => {
    expect(safeVideoEmbed({ type: "video", provider: "YouTube", url: "x", embedUrl: "javascript:alert(1)" }))
      .toMatchObject({ iframeUrl: undefined, mediaUrl: undefined, linkUrl: undefined });
    expect(safeVideoEmbed({ type: "video", provider: "YouTube", url: `https://youtu.be/${YT}`, embedUrl: `https://www.youtube.com/embed/${YT}` }))
      .toMatchObject({ iframeUrl: `https://www.youtube.com/embed/${YT}` });
    expect(safeVideoEmbed({ type: "video", provider: "External", url: "https://example.com/v", embedUrl: "https://evil.example/" }))
      .toMatchObject({ iframeUrl: undefined, mediaUrl: "https://evil.example/", linkUrl: "https://example.com/v" });
  });

  it("binds VideoPlayer to the guarded values, not raw videoData", () => {
    const source = readFileSync("src/components/VideoPlayer.vue", "utf8");
    expect(source).not.toContain(':src="videoData.embedUrl"');
    expect(source).not.toContain(':href="videoData.url"');
    expect(source).toContain("safeVideoEmbed(");
  });
});

describe("APK Content-Security-Policy", () => {
  it("derives the build-time meta policy from public/_headers", async () => {
    const { cspFromHeaders } = await import("../build-plugins/cspMeta");
    const policy = cspFromHeaders(readFileSync("public/_headers", "utf8"));
    expect(policy).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(policy).toContain("frame-src https:");
    expect(policy).toContain("object-src 'none'");
    // Unsupported in <meta>; browsers warn and ignore it.
    expect(policy).not.toContain("frame-ancestors");
  });

  it("registers the CSP meta plugin for production builds only", () => {
    const config = readFileSync("vite.config.ts", "utf8");
    const plugin = readFileSync("build-plugins/cspMeta.ts", "utf8");
    expect(config).toContain('cspMetaPlugin(path.resolve(__dirname, "public/_headers"))');
    expect(plugin).toContain('apply: "build"');
    expect(plugin).toContain('"http-equiv": "Content-Security-Policy"');
  });
});
