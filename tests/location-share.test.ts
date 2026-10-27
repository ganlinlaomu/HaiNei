// One-time location sharing in a DM (first step of location sharing).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createPinia } from "pinia";
import DmLocationCard from "@/components/DmLocationCard.vue";
import LocationShareSheet from "@/components/LocationShareSheet.vue";
import { directMessagePreview } from "@/nostr/messaging/directMessages";
import {
  formatCoordinates,
  LOCATION_SHARE_TYPE,
  mapsUrl,
  parseLocationShare,
  serializeLocationShare,
} from "@/nostr/messaging/locationShare";
import { getCurrentLocation, LocationUnavailableError } from "@/utils/currentLocation";

const AT = 1_793_000_000;
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("location share payload", () => {
  it("round-trips, rounding to about a metre and whole-metre accuracy", () => {
    const content = serializeLocationShare({ lat: 31.230416789, lng: 121.473701234, accuracy: 14.6, at: AT });
    expect(JSON.parse(content)).toEqual({ type: LOCATION_SHARE_TYPE, lat: 31.23042, lng: 121.4737, accuracy: 15, at: AT });
    expect(parseLocationShare(content)).toEqual({ lat: 31.23042, lng: 121.4737, accuracy: 15, at: AT });
    expect(formatCoordinates({ lat: 31.23042, lng: 121.4737 })).toBe("31.23042, 121.47370");
  });

  it("rejects out-of-range, non-numeric or oversized payloads and other message types", () => {
    const base = { type: LOCATION_SHARE_TYPE, lat: 1, lng: 2, at: AT };
    for (const bad of [
      { ...base, lat: 91 }, { ...base, lng: -181 }, { ...base, lat: "1" }, { ...base, at: 0 },
      { ...base, at: 1.5 }, { ...base, accuracy: -1 }, { ...base, accuracy: 1e9 }, { ...base, type: "hainei-friend-recommendation" },
    ]) expect(parseLocationShare(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
    expect(parseLocationShare('{"type":"hainei-location","lat":NaN}')).toBeNull();
    expect(parseLocationShare(JSON.stringify({ ...base, pad: "x".repeat(2000) }))).toBeNull();
    expect(parseLocationShare("晚上见")).toBeNull();
    expect(() => serializeLocationShare({ lat: 100, lng: 0, at: AT })).toThrow("无效的位置");
  });

  it("ignores unknown fields so a later live share still shows as a location card", () => {
    const live = JSON.stringify({ type: LOCATION_SHARE_TYPE, lat: 1, lng: 2, at: AT, shareId: "s1", expiresAt: AT + 900 });
    expect(parseLocationShare(live)).toEqual({ lat: 1, lng: 2, at: AT });
  });

  it("previews as [位置] instead of raw JSON", () => {
    expect(directMessagePreview(serializeLocationShare({ lat: 1, lng: 2, at: AT }))).toBe("[位置]");
  });

  it("opens the system maps app: geo: on Android, Apple Maps elsewhere", () => {
    expect(mapsUrl({ lat: 1.5, lng: 2.25 }, "Mozilla/5.0 (Linux; Android 14)")).toBe("geo:1.5,2.25?q=1.5,2.25");
    expect(mapsUrl({ lat: 1.5, lng: 2.25 }, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)")).toBe(`https://maps.apple.com/?ll=1.5,2.25&q=${encodeURIComponent("位置")}`);
  });
});

describe("reading the device location", () => {
  const geolocation = (error?: { code: number }) => ({
    getCurrentPosition: vi.fn((ok: PositionCallback, fail: PositionErrorCallback, options: PositionOptions) => {
      expect(options).toMatchObject({ enableHighAccuracy: true });
      if (error) fail(error as GeolocationPositionError);
      else ok({ coords: { latitude: 31.2, longitude: 121.4, accuracy: 20 }, timestamp: AT * 1000 } as GeolocationPosition);
    }),
  }) as unknown as Geolocation;

  it("returns coordinates, accuracy and the fix time", async () => {
    await expect(getCurrentLocation({ geolocation: geolocation() })).resolves.toEqual({ lat: 31.2, lng: 121.4, accuracy: 20, at: AT });
  });

  it("explains a denied permission, a timeout and missing support in plain words", async () => {
    await expect(getCurrentLocation({ geolocation: geolocation({ code: 1 }) })).rejects.toThrow("未允许使用位置");
    await expect(getCurrentLocation({ geolocation: geolocation({ code: 3 }) })).rejects.toThrow("获取位置超时");
    await expect(getCurrentLocation({ geolocation: geolocation({ code: 2 }) })).rejects.toThrow("暂时无法获取位置");
    await expect(getCurrentLocation({ geolocation: undefined })).rejects.toBeInstanceOf(LocationUnavailableError);
  });
});

describe("location UI", () => {
  const render = (component: any, props: Record<string, unknown>) => {
    const app = createSSRApp({ render: () => h(component, props) });
    app.use(createPinia());
    return renderToString(app);
  };

  it("renders a card with coordinates and accuracy, without loading any map", async () => {
    const html = await render(DmLocationCard, { location: { lat: 31.23042, lng: 121.4737, accuracy: 15, at: AT }, own: false, peer: "b".repeat(64) });
    expect(html).toContain("31.23042, 121.47370");
    expect(html).toContain("精度约 ±15 米");
    expect(html).toContain("在地图中打开");
    expect(html).toContain("复制坐标");
    expect(html).not.toMatch(/<img|<iframe|tile/i);
  });

  it("asks for the location first and only then offers to send", async () => {
    const html = await render(LocationShareSheet, { peerName: "妈妈" });
    expect(html).toContain("正在获取位置…");
    expect(html).not.toContain(">发送<");
  });

  it("is wired into the chat: menu entry, sheet, card, no burn mode, draft kept", () => {
    const chat = read("src/views/Messages.vue");
    expect(chat).toContain('@click="openLocationSheet"');
    expect(chat).toContain("<LocationShareSheet");
    expect(chat).toContain('<DmLocationCard v-else-if="locationShare(message.content)"');
    expect(chat).toContain("serializeLocationShare(location), undefined, undefined, undefined, { preserveDraft: true }");
    const open = chat.slice(chat.indexOf("function openLocationSheet()"), chat.indexOf("function sendLocation("));
    expect(open).toContain("disappearingSeconds.value !== null");
    expect(read("src/services/privateSpaceImport.ts")).toContain("!parseLocationShare(message.content)");
  });

  it("allows geolocation for this site and declares it in the Android APK", () => {
    expect(read("public/_headers")).toContain("geolocation=(self)");
    const patch = read("scripts/patch-android-update.mjs");
    expect(patch).toContain('["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION"]');
  });
});
