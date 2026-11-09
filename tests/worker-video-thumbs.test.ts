import { describe, expect, it, vi } from "vitest";
import { handleVideoThumbRequest, parseVideoThumbPath } from "../worker/src/videoThumbs";

const PAGE = "https://hainei-9iv.pages.dev";
const request = (path: string, origin: string | null = PAGE) =>
  new Request(`https://hainei-media.example${path}`, { headers: origin ? { Origin: origin } : {} });
const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "Content-Type": "image/jpeg" } });

class MemoryCache {
  store = new Map<string, Response>();
  async match(key: Request) { return this.store.get(key.url)?.clone(); }
  async put(key: Request, value: Response) { this.store.set(key.url, value.clone()); }
}

describe("Worker /api/video-thumb", () => {
  it("YouTube 缩略图经 Worker 取回，浏览器只连 Worker", async () => {
    const fetchUpstream = vi.fn(async () => jpeg());
    const path = "/api/video-thumb/youtube/M7lc1UVf-VE.jpg";
    const response = await handleVideoThumbRequest(request(path), path, { fetchUpstream, cache: new MemoryCache() });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(fetchUpstream.mock.calls[0][0]).toBe("https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg");
  });

  it("Vimeo 先问 oEmbed，只接受 Vimeo 自己的图片地址", async () => {
    const path = "/api/video-thumb/vimeo/76979871.jpg";
    const good = vi.fn(async (url: string) => url.includes("oembed")
      ? Response.json({ thumbnail_url: "https://i.vimeocdn.com/video/452001751-d_640" })
      : jpeg());
    expect((await handleVideoThumbRequest(request(path), path, { fetchUpstream: good, cache: new MemoryCache() })).status).toBe(200);
    expect(good.mock.calls.map(([url]) => url)).toEqual([
      `https://vimeo.com/api/oembed.json?url=${encodeURIComponent("https://vimeo.com/76979871")}&width=640`,
      "https://i.vimeocdn.com/video/452001751-d_640",
    ]);

    const evil = vi.fn(async () => Response.json({ thumbnail_url: "https://evil.example/x.jpg" }));
    expect((await handleVideoThumbRequest(request(path), path, { fetchUpstream: evil, cache: new MemoryCache() })).status).toBe(404);
    expect(evil).toHaveBeenCalledOnce();
  });

  it("按视频缓存，第二次不再访问上游", async () => {
    const fetchUpstream = vi.fn(async () => jpeg());
    const cache = new MemoryCache();
    const path = "/api/video-thumb/youtube/M7lc1UVf-VE.jpg";
    await handleVideoThumbRequest(request(path), path, { fetchUpstream, cache });
    expect((await handleVideoThumbRequest(request(path), path, { fetchUpstream, cache })).status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledOnce();
  });

  it("上游不是图片或出错时返回 404，不缓存", async () => {
    const path = "/api/video-thumb/youtube/M7lc1UVf-VE.jpg";
    const cache = new MemoryCache();
    const html = vi.fn(async () => new Response("<html>", { headers: { "Content-Type": "text/html" } }));
    expect((await handleVideoThumbRequest(request(path), path, { fetchUpstream: html, cache })).status).toBe(404);
    const failing = vi.fn(async () => { throw new Error("network"); });
    expect((await handleVideoThumbRequest(request(path), path, { fetchUpstream: failing, cache })).status).toBe(404);
    expect(cache.store.size).toBe(0);
  });

  it("只允许 HaiNei 页面，id 必须合法", async () => {
    const upstream = vi.fn();
    const path = "/api/video-thumb/youtube/M7lc1UVf-VE.jpg";
    expect((await handleVideoThumbRequest(request(path, "https://evil.example"), path, { fetchUpstream: upstream })).status).toBe(403);
    for (const bad of ["/api/video-thumb/youtube/short.jpg", "/api/video-thumb/vimeo/abc.jpg", "/api/video-thumb/other/1.jpg", "/api/video-thumb/youtube/M7lc1UVf-VE.png"]) {
      expect(parseVideoThumbPath(bad)).toBeNull();
      expect((await handleVideoThumbRequest(request(bad), bad, { fetchUpstream: upstream })).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("路由已注册", async () => {
    const { handleRequest } = await import("../worker/src/index");
    const response = await handleRequest(request("/api/video-thumb/youtube/bad.jpg"), {} as never);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });
});
