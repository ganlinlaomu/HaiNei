// Location map: OSM tiles through the HaiNei Worker, drawn without a map library.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString, type SSRContext } from "vue/server-renderer";
import { createPinia } from "pinia";
import { centerOf, fitZoom, project, tilesFor, tileUrl, toScreen, TILE_SIZE } from "@/utils/mapTiles";
import { handleTileRequest, parseTilePath, tileRequestAllowed } from "../worker/src/tiles";
import { handleRequest } from "../worker/src/index";
import LocationMapSheet from "@/components/LocationMapSheet.vue";
import DmLocationCard from "@/components/DmLocationCard.vue";

const SHANGHAI = { lat: 31.2304, lng: 121.4737 };
const NEARBY = { lat: 31.2404, lng: 121.4837 };

describe("tile math", () => {
  it("projects to Web Mercator world pixels", () => {
    expect(project({ lat: 0, lng: 0 }, 0)).toEqual({ x: 128, y: 128 });
    const p = project(SHANGHAI, 16);
    // The slippy-map tile formula in its asinh form, as an independent check.
    const n = 2 ** 16, lat = SHANGHAI.lat * Math.PI / 180;
    const expected = [Math.floor((SHANGHAI.lng + 180) / 360 * n), Math.floor((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * n)];
    expect([Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE)]).toEqual(expected);
    expect(expected).toEqual([54881, 26778]);
  });

  it("zooms in on one point and out just enough for two", () => {
    expect(fitZoom([SHANGHAI], 390, 500)).toBe(16);
    const zoom = fitZoom([SHANGHAI, NEARBY], 390, 500);
    expect(zoom).toBeLessThan(16);
    for (const point of [SHANGHAI, NEARBY]) {
      const { left, top } = toScreen(point, centerOf([SHANGHAI, NEARBY], zoom), zoom, 390, 500);
      expect(left).toBeGreaterThanOrEqual(56);
      expect(left).toBeLessThanOrEqual(390 - 56);
      expect(top).toBeGreaterThanOrEqual(56);
      expect(top).toBeLessThanOrEqual(500 - 56);
    }
  });

  it("covers the viewport with tiles, wrapping around the antimeridian", () => {
    const center = project(SHANGHAI, 16);
    const tiles = tilesFor(center, 16, 390, 844);
    expect(tiles.length).toBeGreaterThanOrEqual(2 * 4);
    expect(tiles.every(tile => tile.left > -TILE_SIZE && tile.left < 390 && tile.top > -TILE_SIZE && tile.top < 844)).toBe(true);
    expect(toScreen(SHANGHAI, center, 16, 390, 844)).toEqual({ left: 195, top: 422 });
    const edge = tilesFor({ x: 2, y: 600 }, 2, 400, 200);
    expect(edge.some(tile => tile.x === 3)).toBe(true);
    expect(tileUrl("https://w.test", { z: 16, x: 1, y: 2 })).toBe("https://w.test/tiles/16/1/2.png");
  });
});

describe("Worker tile proxy", () => {
  const request = (referer?: string, origin?: string) => new Request("https://worker.test/tiles/16/54882/26791.png", {
    headers: {
      ...(referer ? { Referer: referer } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
  });
  const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });

  it("accepts only valid tiles from HaiNei pages", () => {
    expect(parseTilePath("/tiles/16/54882/26791.png")).toEqual({ z: 16, x: 54882, y: 26791 });
    for (const bad of ["/tiles/19/0/0.png", "/tiles/1/0/0.png", "/tiles/3/8/0.png", "/tiles/3/0/0.jpg", "/tiles/3/0/0.png/x"]) {
      expect(parseTilePath(bad), bad).toBeNull();
    }
    expect(tileRequestAllowed(request("https://hainei-9iv.pages.dev/"))).toBe(true);
    expect(tileRequestAllowed(request("https://abc123.hainei-9iv.pages.dev/"))).toBe(true);
    expect(tileRequestAllowed(request(undefined, "https://hainei-9iv.pages.dev"))).toBe(true);
    expect(tileRequestAllowed(request(undefined, "https://abc123.hainei-9iv.pages.dev"))).toBe(true);
    expect(tileRequestAllowed(request("https://localhost/"))).toBe(true);
    expect(tileRequestAllowed(request("https://evil.example/"))).toBe(false);
    expect(tileRequestAllowed(request("https://hainei-9iv.pages.dev.evil.example/"))).toBe(false);
    // If CORS supplied Origin, do not fall back to a conflicting Referer.
    expect(tileRequestAllowed(request("https://hainei-9iv.pages.dev/", "https://evil.example"))).toBe(false);
    expect(tileRequestAllowed(request())).toBe(false);
  });

  it("fetches with an identifying User-Agent once, then serves from the edge cache", async () => {
    const store = new Map<string, Response>();
    const cache = { match: vi.fn(async (key: Request) => store.get(key.url)?.clone()), put: vi.fn(async (key: Request, value: Response) => { store.set(key.url, value); }) };
    const fetchUpstream = vi.fn(async () => png());
    const first = await handleTileRequest(request("https://hainei-9iv.pages.dev/"), "/tiles/16/54882/26791.png", { fetchUpstream, cache });
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toBe("image/png");
    const [url, init] = fetchUpstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tile.openstreetmap.org/16/54882/26791.png");
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("HaiNei");
    const second = await handleTileRequest(request("https://hainei-9iv.pages.dev/chat"), "/tiles/16/54882/26791.png", { fetchUpstream, cache });
    expect(second.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledOnce();
  });

  it("refuses foreign pages and passes no upstream error page through", async () => {
    const fetchUpstream = vi.fn(async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect((await handleTileRequest(request("https://evil.example/"), "/tiles/3/0/0.png", { fetchUpstream })).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect((await handleTileRequest(request("https://hainei-9iv.pages.dev/"), "/tiles/3/0/0.png", { fetchUpstream })).status).toBe(502);
  });

  it("is routed for GET before the POST-only API", async () => {
    const response = await handleRequest(new Request("https://worker.test/tiles/3/0/0.png"), {} as any);
    expect(response.status).toBe(403);
  });
});

describe("map UI", () => {
  async function render(component: any, props: Record<string, unknown>) {
    const app = createSSRApp({ render: () => h(component, props) });
    app.use(createPinia());
    const context: SSRContext = {};
    const html = await renderToString(app, context);
    return html + Object.values(context.teleports || {}).join("");
  }

  it("draws Worker tiles with origin-only referrers, both positions and the OSM attribution", async () => {
    const html = await render(LocationMapSheet, {
      peerName: "妈妈", peerPubkey: "b".repeat(64), status: "更新于 刚刚",
      location: { ...NEARBY, at: 1 }, myLocation: { ...SHANGHAI, at: 1 },
    });
    expect(html).toContain("妈妈的位置");
    expect(html).toMatch(/src="[^"]*\/tiles\/\d+\/\d+\/\d+\.png"/);
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).toContain('referrerpolicy="origin"');
    expect(html).toContain("© OpenStreetMap");
    expect(html).toContain('aria-label="我的位置"');
    expect(html).toContain("在「地图」中打开");
  });

  it("embeds a viewport-lazy map preview that opens the full-screen map", async () => {
    const html = await render(DmLocationCard, { location: { ...SHANGHAI, at: 1 }, own: false, peer: "b".repeat(64), peerName: "妈妈" });
    expect(html).toContain("查看大图");
    expect(html).toContain("地图加载中…");
    // SSR and off-screen cards do not download tiles before becoming visible.
    expect(html).not.toMatch(/<img/);
    const cardSource = readFileSync(join(process.cwd(), "src/components/DmLocationCard.vue"), "utf8");
    const previewSource = readFileSync(join(process.cwd(), "src/components/LocationMapPreview.vue"), "utf8");
    expect(cardSource).toContain("<LocationMapPreview");
    expect(previewSource).toContain("new IntersectionObserver");
    expect(previewSource).toContain('crossorigin="anonymous"');
  });
});
