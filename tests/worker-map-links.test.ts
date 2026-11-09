import { describe, expect, it, vi } from "vitest";
import { handleMapLinkRequest } from "../worker/src/mapLinks";

const PAGE = "https://hainei-9iv.pages.dev";
const SHORT = "https://maps.app.goo.gl/akkoLdQVouxV8ve17";
const PLACE = "https://www.google.com/maps/place/A%CC%8ATER+Tokyo/@35.6874623,139.84663,17z/data=!3m1!4b1!3d35.6874623!4d139.84663";
const ADDRESS_ONLY = `https://maps.google.com/?q=${encodeURIComponent("日本、〒151-0051 東京都渋谷区千駄ケ谷３丁目３０−１ Green Beans Coffee")}&entry=gps`;

const request = (url: string, origin: string | null = PAGE) =>
  new Request(`https://hainei-media.example/api/map-link?u=${encodeURIComponent(url)}`, { headers: origin ? { Origin: origin } : {} });
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });
const gsi = (title: string, lng = 139.707901, lat = 35.67746) =>
  Response.json([{ geometry: { coordinates: [lng, lat] }, properties: { title } }]);

class MemoryCache {
  store = new Map<string, Response>();
  async match(key: Request) { return this.store.get(key.url)?.clone(); }
  async put(key: Request, value: Response) { this.store.set(key.url, value.clone()); }
}

async function call(url: string, upstream: (target: string, init: RequestInit) => Response, origin?: string | null) {
  const fetchUpstream = vi.fn(async (target: string, init: RequestInit) => upstream(target, init));
  const cache = new MemoryCache();
  const response = await handleMapLinkRequest(request(url, origin), { fetchUpstream, cache });
  return { response, body: response.ok ? await response.clone().json() : null, fetchUpstream, cache };
}

describe("Worker /api/map-link", () => {
  it("短链接跟随跳转，从地点页地址里取坐标", async () => {
    const { body, fetchUpstream, response } = await call(SHORT, () => redirect(PLACE));
    expect(body).toEqual({ lat: 35.6874623, lng: 139.84663 });
    expect(fetchUpstream).toHaveBeenCalledOnce();
    expect(fetchUpstream.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("只有住址时用国土地理院查坐标", async () => {
    const { body, fetchUpstream } = await call(ADDRESS_ONLY, () => gsi("東京都渋谷区千駄ケ谷三丁目３０番１号"));
    expect(body).toEqual({ lat: 35.67746, lng: 139.707901 });
    expect(fetchUpstream.mock.calls[0][0]).toBe(
      `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent("東京都渋谷区千駄ケ谷3丁目30-1")}`);
  });

  it("英文住址先用邮编查出日文町名，再查坐标", async () => {
    const phoneShare = `https://maps.google.com/?q=${encodeURIComponent("〒151-0051 Tokyo, Shibuya, Sendagaya, 3 Chome−30−1 Green Beans Coffee")}&entry=gps`;
    const { body, fetchUpstream } = await call(phoneShare, target => target.includes("zipcloud")
      ? Response.json({ results: [{ address1: "東京都", address2: "渋谷区", address3: "千駄ヶ谷" }] })
      : gsi("東京都渋谷区千駄ケ谷三丁目３０番１号"));
    expect(body).toEqual({ lat: 35.67746, lng: 139.707901 });
    expect(fetchUpstream.mock.calls.map(([target]) => target)).toEqual([
      "https://zipcloud.ibsnet.co.jp/api/search?zipcode=1510051",
      `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent("東京都渋谷区千駄ヶ谷3-30-1")}`,
    ]);
  });

  it("邮编对应多个町，或是「以下に掲載がない場合」时不猜", async () => {
    const phoneShare = `https://maps.google.com/?q=${encodeURIComponent("〒100-0000 Tokyo, 1 Chome-1-1")}`;
    for (const results of [
      [{ address1: "東京都", address2: "千代田区", address3: "丸の内" }, { address1: "東京都", address2: "千代田区", address3: "大手町" }],
      [{ address1: "東京都", address2: "千代田区", address3: "以下に掲載がない場合" }],
    ]) {
      const { body, fetchUpstream } = await call(phoneShare, () => Response.json({ results }));
      expect(body).toEqual({});
      expect(fetchUpstream).toHaveBeenCalledOnce();
    }
  });

  it("查到别的都道府县就当没找到", async () => {
    const { body } = await call(ADDRESS_ONLY, () => gsi("長野県麻績村日", 138.0, 36.4));
    expect(body).toEqual({});
  });

  it("跳转到地图以外的网站就停下，不去访问", async () => {
    const { body, fetchUpstream } = await call(SHORT, () => redirect("https://evil.example/@35,139"));
    expect(body).toEqual({});
    expect(fetchUpstream).toHaveBeenCalledOnce();
  });

  it("跳转次数有上限", async () => {
    let hop = 0;
    const { body, fetchUpstream } = await call(SHORT, () => redirect(`https://maps.google.com/?q=place${hop++}`));
    expect(body).toEqual({});
    expect(fetchUpstream).toHaveBeenCalledTimes(5);
  });

  it("结果按链接缓存，第二次不再访问上游", async () => {
    const fetchUpstream = vi.fn(async () => redirect(PLACE));
    const cache = new MemoryCache();
    await handleMapLinkRequest(request(SHORT), { fetchUpstream, cache });
    const second = await handleMapLinkRequest(request(SHORT), { fetchUpstream, cache });
    expect(await second.json()).toEqual({ lat: 35.6874623, lng: 139.84663 });
    expect(fetchUpstream).toHaveBeenCalledOnce();
  });

  it("上游出错时返回没找到，且不长期缓存", async () => {
    const { body, response, cache } = await call(SHORT, () => { throw new Error("network"); });
    expect(body).toEqual({});
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(cache.store.size).toBe(0);
  });

  it("只允许 HaiNei 页面调用，只接受 https 地图链接", async () => {
    const upstream = vi.fn();
    expect((await handleMapLinkRequest(request(SHORT, "https://evil.example"), { fetchUpstream: upstream })).status).toBe(403);
    expect((await handleMapLinkRequest(request(SHORT, null), { fetchUpstream: upstream })).status).toBe(403);
    for (const url of ["https://example.com/a", "http://maps.app.goo.gl/x", "javascript:alert(1)", `${SHORT}?${"x".repeat(3000)}`]) {
      expect((await handleMapLinkRequest(request(url), { fetchUpstream: upstream })).status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("带坐标的长链接不访问上游", async () => {
    const { body, fetchUpstream } = await call(PLACE, () => { throw new Error("should not fetch"); });
    expect(body).toEqual({ lat: 35.6874623, lng: 139.84663 });
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("Worker 路由", () => {
  it("GET /api/map-link 交给 handleMapLinkRequest", async () => {
    const { handleRequest } = await import("../worker/src/index");
    const response = await handleRequest(request("https://example.com/not-a-map"), {} as never);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("bad request");
  });
});
