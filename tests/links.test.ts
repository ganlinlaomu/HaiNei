import { describe, expect, it } from "vitest";
import { classifyLink, linkCardsFor, linkHost, normalizeLinkUrl, splitLinks, stripLinks } from "@/utils/links";

const links = (text: string) => splitLinks(text).filter(segment => segment.type === "link").map(segment => segment.text);

describe("splitLinks", () => {
  it("没有链接时原样返回", () => {
    expect(splitLinks("今天天气不错")).toEqual([{ type: "text", text: "今天天气不错" }]);
    expect(splitLinks("")).toEqual([{ type: "text", text: "" }]);
  });

  it("切出链接，前后文字保持原样", () => {
    expect(splitLinks("看这个 https://example.com/a?b=1 好玩")).toEqual([
      { type: "text", text: "看这个 " },
      { type: "link", text: "https://example.com/a?b=1", url: "https://example.com/a?b=1" },
      { type: "text", text: " 好玩" },
    ]);
  });

  it("中文和日文标点不算进链接", () => {
    expect(links("看这个https://example.com/x。")).toEqual(["https://example.com/x"]);
    expect(links("链接：https://example.com/x，然后")).toEqual(["https://example.com/x"]);
    expect(links("「https://example.jp/a」を見て")).toEqual(["https://example.jp/a"]);
    expect(links("（https://example.com/x）")).toEqual(["https://example.com/x"]);
  });

  it("去掉句尾的英文标点，但保留链接自带的括号", () => {
    expect(links("see https://example.com/x.")).toEqual(["https://example.com/x"]);
    expect(links("wow https://example.com/x!?")).toEqual(["https://example.com/x"]);
    expect(links("(see https://example.com/x)")).toEqual(["https://example.com/x"]);
    expect(links("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });

  it("www. 开头的地址补上 https", () => {
    expect(splitLinks("www.example.com")).toEqual([{ type: "link", text: "www.example.com", url: "https://www.example.com/" }]);
  });

  it("一段文字里多个链接", () => {
    expect(links("a https://a.com b http://b.org/x c")).toEqual(["https://a.com", "http://b.org/x"]);
  });

  it("中文域名和路径也能识别", () => {
    expect(links("https://ja.wikipedia.org/wiki/東京 です")).toEqual(["https://ja.wikipedia.org/wiki/東京"]);
  });
});

describe("normalizeLinkUrl", () => {
  it("只接受 http/https，且主机名要有点", () => {
    expect(normalizeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("data:text/html,x")).toBeNull();
    expect(normalizeLinkUrl("https://localhost/x")).toBeNull();
    expect(normalizeLinkUrl("https://user:pw@example.com/")).toBeNull();
    expect(normalizeLinkUrl("https://example.com")).toBe("https://example.com/");
  });
});

describe("classifyLink", () => {
  const kind = (url: string) => classifyLink(url).kind;

  it("YouTube 各种地址都能拿到可嵌入的播放地址", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?t=10",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    ]) {
      expect(classifyLink(url)).toMatchObject({
        kind: "youtube", site: "YouTube",
        embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1",
      });
    }
    expect(classifyLink("https://youtu.be/dQw4w9WgXcQ").thumbPath).toBe("/api/video-thumb/youtube/dQw4w9WgXcQ.jpg");
    expect(classifyLink("https://vimeo.com/76979871").thumbPath).toBe("/api/video-thumb/vimeo/76979871.jpg");
    expect(classifyLink("https://www.youtube.com/@channel")).toMatchObject({ kind: "youtube", embedUrl: undefined, thumbPath: undefined });
    expect(classifyLink("https://youtu.be/<script>")).toMatchObject({ kind: "youtube", embedUrl: undefined });
  });

  it("Vimeo 数字 id 可嵌入", () => {
    expect(classifyLink("https://vimeo.com/76979871")).toMatchObject({ kind: "vimeo", embedUrl: "https://player.vimeo.com/video/76979871?autoplay=1" });
    expect(classifyLink("https://vimeo.com/channels/staff")).toMatchObject({ kind: "vimeo", embedUrl: undefined });
  });

  it("识别常见网站", () => {
    expect(kind("https://x.com/jack/status/20")).toBe("x");
    expect(kind("https://twitter.com/jack")).toBe("x");
    expect(kind("https://mobile.twitter.com/jack")).toBe("x");
    expect(kind("https://www.instagram.com/p/abc/")).toBe("instagram");
    expect(kind("https://vm.tiktok.com/xyz/")).toBe("tiktok");
    expect(kind("https://www.nicovideo.jp/watch/sm9")).toBe("niconico");
    expect(kind("https://nico.ms/sm9")).toBe("niconico");
    expect(kind("https://maps.app.goo.gl/abc")).toBe("maps");
    expect(kind("https://www.google.com/maps/place/Tokyo")).toBe("maps");
    expect(kind("https://www.google.co.jp/maps/@35.6,139.7,15z")).toBe("maps");
    expect(kind("https://maps.apple.com/?q=Tokyo")).toBe("maps");
    expect(kind("https://www.amazon.co.jp/dp/B000")).toBe("amazon");
    expect(kind("https://amzn.asia/d/abc")).toBe("amazon");
    expect(kind("https://github.com/vuejs/core")).toBe("github");
    expect(kind("https://ja.wikipedia.org/wiki/東京")).toBe("wikipedia");
    expect(kind("https://open.spotify.com/track/abc")).toBe("spotify");
    expect(kind("https://line.me/R/ti/p/abc")).toBe("line");
    expect(kind("https://example.com/photo.JPG")).toBe("image");
  });

  it("相似但不同的域名不会被误认", () => {
    expect(kind("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBe("web");
    expect(kind("https://x.com.evil.example/a")).toBe("web");
    expect(kind("https://www.google.com/search?q=maps")).toBe("web");
    expect(kind("https://fakegithub.com/a")).toBe("web");
  });

  it("只显示域名，不显示路径和参数", () => {
    expect(classifyLink("https://www.example.com/a?b=1").display).toBe("example.com");
    expect(classifyLink(`https://www.amazon.co.jp/dp/B000?tag=${"x".repeat(80)}`).display).toBe("amazon.co.jp");
    expect(linkHost("https://maps.app.goo.gl/abc")).toBe("maps.app.goo.gl");
  });

  it("普通网页的站点名是域名", () => {
    expect(classifyLink("https://www.tenki.jp/forecast")).toMatchObject({ kind: "web", site: "tenki.jp" });
  });
});

describe("linkCardsFor", () => {
  it("只给认识的网站出卡片，同一链接只出一次，最多 3 张", () => {
    const text = [
      "https://example.com/page",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://x.com/a",
      "https://github.com/a",
      "https://open.spotify.com/b",
    ].join(" ");
    expect(linkCardsFor(text).map(card => card.kind)).toEqual(["youtube", "x", "github"]);
    expect(linkCardsFor(text, 1).map(card => card.kind)).toEqual(["youtube"]);
    expect(linkCardsFor("只有 https://example.com")).toEqual([]);
  });
});

describe("stripLinks", () => {
  const strip = (text: string, ...urls: string[]) => stripLinks(text, new Set(urls));

  it("去掉指定的链接，整理留下的空格", () => {
    expect(strip("看这个视频 https://youtu.be/dQw4w9WgXcQ ，还有别的", "https://youtu.be/dQw4w9WgXcQ")).toBe("看这个视频，还有别的");
    expect(strip("看 https://x.com/a 和 https://example.com/b", "https://x.com/a")).toBe("看 和 https://example.com/b");
    expect(strip("https://x.com/a", "https://x.com/a")).toBe("");
  });

  it("保留换行，只收掉多余的空行", () => {
    expect(strip("第一行\nhttps://x.com/a\n\n\n第二行", "https://x.com/a")).toBe("第一行\n\n第二行");
  });

  it("没有要去掉的链接时原样返回", () => {
    expect(strip("看  https://example.com")).toBe("看  https://example.com");
  });
});
