import { describe, expect, it } from "vitest";
import {
  coordinatesFromMapUrl, isMapLink, isMapShortLink, japaneseAddressFromMapUrl, prefectureOf, romanizedJapaneseAddressParts,
} from "@/utils/mapLinkLocation";

// Real targets of maps.app.goo.gl share links (2026-11).
const PLACE = "https://www.google.com/maps/place/A%CC%8ATER+Tokyo/@35.6874623,139.84663,17z/data=!3m1!4b1!4m6!3m5!1s0x601889c0fc62a5b3:0xf5bb8276aa11f58f!8m2!3d35.6874623!4d139.84663!16s%2Fg%2F11stfbys1w?entry=tts";
const PHONE_SHARE = "https://maps.google.com/?q=%E3%80%92151-0051+Tokyo,+Shibuya,+Sendagaya,+3+Chome%E2%88%9230%E2%88%921+Green+Beans+Coffee,+RC+APARTMENT1F&ftid=0x60188d4404ef151f:0x85142d57557d0f87&entry=gps";

describe("地图链接里的坐标", () => {
  it("地点页优先用地点本身的 !3d!4d", () => {
    expect(coordinatesFromMapUrl(PLACE)).toEqual({ lat: 35.6874623, lng: 139.84663 });
    expect(coordinatesFromMapUrl("https://www.google.com/maps/place/X/@35.1,139.1,17z/data=!3d35.2!4d139.2")).toEqual({ lat: 35.2, lng: 139.2 });
  });

  it("视图中心 @lat,lng 和各种参数", () => {
    expect(coordinatesFromMapUrl("https://www.google.co.jp/maps/@35.6812,139.7671,15z")).toEqual({ lat: 35.6812, lng: 139.7671 });
    expect(coordinatesFromMapUrl("https://maps.google.com/?q=35.6812,139.7671")).toEqual({ lat: 35.6812, lng: 139.7671 });
    expect(coordinatesFromMapUrl("https://www.google.com/maps/search/?api=1&query=35.6812%2C139.7671")).toEqual({ lat: 35.6812, lng: 139.7671 });
    expect(coordinatesFromMapUrl("https://www.google.com/maps/dir/?api=1&destination=34.70,135.49")).toEqual({ lat: 34.7, lng: 135.49 });
  });

  it("Apple 地图", () => {
    expect(coordinatesFromMapUrl("https://maps.apple.com/?ll=35.6812,139.7671&q=Tokyo")).toEqual({ lat: 35.6812, lng: 139.7671 });
    expect(coordinatesFromMapUrl("https://maps.apple.com/place?coordinate=35.6,139.7&name=X")).toEqual({ lat: 35.6, lng: 139.7 });
  });

  it("没有坐标、坐标越界或不是地图链接时返回 null", () => {
    expect(coordinatesFromMapUrl(PHONE_SHARE)).toBeNull();
    expect(coordinatesFromMapUrl("https://maps.app.goo.gl/akkoLdQVouxV8ve17")).toBeNull();
    expect(coordinatesFromMapUrl("https://maps.google.com/?q=95,200")).toBeNull();
    expect(coordinatesFromMapUrl("https://maps.google.com/?q=0,0")).toBeNull();
    expect(coordinatesFromMapUrl("https://example.com/maps/@35.6,139.7,15z")).toBeNull();
    expect(coordinatesFromMapUrl("https://www.google.com/search?q=35.6,139.7")).toBeNull();
  });
});

describe("哪些是地图链接", () => {
  it("短链接", () => {
    expect(isMapShortLink("https://maps.app.goo.gl/akkoLdQVouxV8ve17")).toBe(true);
    expect(isMapShortLink("https://goo.gl/maps/abc")).toBe(true);
    expect(isMapShortLink("https://goo.gl/abc")).toBe(false);
    expect(isMapShortLink("http://maps.app.goo.gl/abc")).toBe(false);
  });

  it("Google / Apple 地图和短链接都算，其他网站不算", () => {
    expect(isMapLink(PLACE)).toBe(true);
    expect(isMapLink(PHONE_SHARE)).toBe(true);
    expect(isMapLink("https://maps.apple.com/?q=x")).toBe(true);
    expect(isMapLink("https://maps.app.goo.gl/x")).toBe(true);
    expect(isMapLink("https://www.google.com/search?q=maps")).toBe(false);
    expect(isMapLink("https://evil.example/maps")).toBe(false);
  });
});

describe("只有住址的地图链接", () => {
  const withQ = (q: string) => `https://maps.google.com/?q=${encodeURIComponent(q)}&ftid=0x1:0x2&entry=gps`;

  it("取出日文住址：去掉邮编和国家，数字转半角，丢掉后面的店名", () => {
    expect(japaneseAddressFromMapUrl(withQ("日本、〒151-0051 東京都渋谷区千駄ケ谷３丁目３０−１ Green Beans Coffee"))).toBe("東京都渋谷区千駄ケ谷3丁目30-1");
    expect(japaneseAddressFromMapUrl(withQ("〒530-0001 大阪府大阪市北区梅田３丁目１−１"))).toBe("大阪府大阪市北区梅田3丁目1-1");
    expect(japaneseAddressFromMapUrl(withQ("北海道札幌市中央区北１条西２丁目、札幌市役所"))).toBe("北海道札幌市中央区北1条西2丁目");
    expect(japaneseAddressFromMapUrl(withQ("神奈川県横浜市中区本町6丁目50-10"))).toBe("神奈川県横浜市中区本町6丁目50-10");
  });

  it("英文转写的住址、没有门牌号的文字不当成住址", () => {
    expect(japaneseAddressFromMapUrl(PHONE_SHARE)).toBeNull();
    expect(japaneseAddressFromMapUrl(withQ("東京都"))).toBeNull();
    expect(japaneseAddressFromMapUrl(withQ("Green Beans Coffee"))).toBeNull();
    expect(japaneseAddressFromMapUrl("https://example.com/?q=東京都渋谷区1-1")).toBeNull();
  });

  it("取出都道府县，用来核对查询结果", () => {
    expect(prefectureOf("東京都渋谷区千駄ケ谷3丁目30-1")).toBe("東京都");
    expect(prefectureOf("京都府京都市")).toBe("京都府");
    expect(prefectureOf("神奈川県横浜市")).toBe("神奈川県");
  });
});

describe("英文转写的日本住址", () => {
  const withQ = (q: string) => `https://maps.google.com/?q=${encodeURIComponent(q)}&entry=gps`;

  it("取出邮编和丁目门牌", () => {
    expect(romanizedJapaneseAddressParts(PHONE_SHARE)).toEqual({ postcode: "1510051", block: "3-30-1" });
    expect(romanizedJapaneseAddressParts(withQ("〒530-0001 Osaka, Kita Ward, Umeda, 3 Chome-1-1"))).toEqual({ postcode: "5300001", block: "3-1-1" });
    expect(romanizedJapaneseAddressParts(withQ("2-11-3 Meguro, Tokyo 153-0063, Japan"))).toEqual({ postcode: "1530063", block: "2-11-3" });
  });

  it("没有邮编或门牌就不算", () => {
    expect(romanizedJapaneseAddressParts(withQ("Shibuya, Tokyo 150-0002"))).toBeNull();
    expect(romanizedJapaneseAddressParts(withQ("3 Chome-30-1 Sendagaya"))).toBeNull();
    expect(romanizedJapaneseAddressParts("https://example.com/?q=151-0051+3+Chome-30-1")).toBeNull();
  });
});
