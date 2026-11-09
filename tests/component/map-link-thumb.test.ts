// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const SHORT = "https://maps.app.goo.gl/akkoLdQVouxV8ve17";

describe("地图卡片的缩略图", () => {
  const resolved = vi.hoisted(() => ({ value: null as null | { lat: number; lng: number } }));
  vi.mock("@/services/mapLinkPoints", async original => ({
    ...(await original<typeof import("@/services/mapLinkPoints")>()),
    mapLinkPoint: vi.fn(async () => resolved.value),
  }));
  vi.mock("@/components/LocationMapPreview.vue", () => ({
    default: { props: ["location", "label"], template: `<div class="preview">{{ location.lat }},{{ location.lng }}</div>` },
  }));

  let observed: Array<(entries: Array<{ isIntersecting: boolean }>) => void>;
  beforeEach(() => {
    observed = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observed.push(callback); }
      observe() {}
      disconnect() {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("滚到可见才去查坐标，查到就显示地图", async () => {
    const { mapLinkPoint: spy } = await import("@/services/mapLinkPoints");
    vi.mocked(spy).mockClear();
    resolved.value = { lat: 35.6874623, lng: 139.84663 };
    const { default: MapLinkThumb } = await import("@/components/MapLinkThumb.vue");
    const wrapper = mount(MapLinkThumb, { props: { url: SHORT } });
    await flushPromises();
    expect(spy).not.toHaveBeenCalled();
    expect(wrapper.find(".preview").exists()).toBe(false);

    observed[0]([{ isIntersecting: true }]);
    await flushPromises();

    expect(spy).toHaveBeenCalledWith(SHORT);
    expect(wrapper.get(".preview").text()).toBe("35.6874623,139.84663");
  });

  it("查不到坐标就不显示地图，卡片照常", async () => {
    resolved.value = null;
    const { default: MapLinkThumb } = await import("@/components/MapLinkThumb.vue");
    const wrapper = mount(MapLinkThumb, { props: { url: SHORT } });
    observed[0]([{ isIntersecting: true }]);
    await flushPromises();
    expect(wrapper.find(".preview").exists()).toBe(false);
    expect(wrapper.classes()).toContain("empty");
  });

  it("地图卡片里放了缩略图，点缩略图打开地图链接", async () => {
    resolved.value = { lat: 35.6, lng: 139.7 };
    const { default: LinkCards } = await import("@/components/LinkCards.vue");
    const wrapper = mount(LinkCards, { props: { text: `集合 ${SHORT}` } });
    const thumbLink = wrapper.get("a.link-map");
    expect(thumbLink.attributes()).toMatchObject({ href: SHORT, target: "_blank" });
    observed[0]([{ isIntersecting: true }]);
    await flushPromises();
    expect(thumbLink.find(".preview").exists()).toBe(true);
  });
});

describe("缩略图的观察目标", () => {
  it("没查到坐标时是零高度而不是 display:none，否则永远不会进入可见区域", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/MapLinkThumb.vue", "utf8");
    expect(source).toContain(".map-link-thumb.empty{height:0;overflow:hidden}");
    expect(source).not.toMatch(/\.map-link-thumb\.empty\{display:none/);
  });
});
