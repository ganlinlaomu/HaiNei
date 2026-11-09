// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import LinkCards from "@/components/LinkCards.vue";
import MentionText from "@/components/MentionText.vue";
import VideoPlayer from "@/components/VideoPlayer.vue";

const FRIEND = "f".repeat(64);
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: "a".repeat(64) }) }));
vi.mock("@/stores/friends", () => ({
  useFriendsStore: () => ({ getAcceptedList: () => [{ pubkey: FRIEND, name: "alice" }] }),
}));
vi.mock("@/stores/friendships", () => ({ useFriendshipsStore: () => ({ isAccepted: () => true }) }));
vi.mock("@/stores/profiles", () => ({ useProfilesStore: () => ({ getProfile: () => undefined }) }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ dataSaver: false }) }));

describe("正文里的链接", () => {
  it("链接变成新窗口打开的 <a>，不带来源信息", () => {
    const wrapper = mount(MentionText, { props: { text: "看 https://example.com/a。好" } });
    const link = wrapper.get("a.text-link");
    expect(link.attributes()).toMatchObject({
      href: "https://example.com/a",
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    });
    // Running text shows only the host; the full URL is what opens.
    expect(link.text()).toBe("example.com");
    expect(link.attributes("title")).toBe("https://example.com/a");
    expect(wrapper.text()).toBe("看 example.com。好");
  });

  it("@提及 和链接可以同时出现；链接里的 @ 不会被当成提及", () => {
    const wrapper = mount(MentionText, { props: { text: "@alice 看 https://x.com/@alice" } });
    expect(wrapper.get("button.mention-link").text()).toBe("@alice");
    expect(wrapper.get("a.text-link").attributes("href")).toBe("https://x.com/@alice");
    expect(wrapper.findAll("button.mention-link")).toHaveLength(1);
  });

  it("javascript: 之类的地址不会变成链接", () => {
    const wrapper = mount(MentionText, { props: { text: "javascript:alert(1) data:text/html,x" } });
    expect(wrapper.find("a").exists()).toBe(false);
  });

  it("点链接不会触发外层（气泡、帖子）的点击", async () => {
    const outer = vi.fn();
    const wrapper = mount({
      components: { MentionText },
      template: `<div @click="outer"><MentionText text="https://example.com" /></div>`,
      setup: () => ({ outer }),
    });
    await wrapper.get("a").trigger("click");
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("链接卡片", () => {
  it("普通网页不出卡片", () => {
    expect(mount(LinkCards, { props: { text: "https://example.com" } }).find(".link-card").exists()).toBe(false);
  });

  it("认识的网站显示站点名和简短地址，点卡片打开原链接", () => {
    const wrapper = mount(LinkCards, { props: { text: "https://x.com/jack/status/20 和 https://github.com/vuejs/core" } });
    const cards = wrapper.findAll(".link-card");
    expect(cards.map(card => card.get("strong").text())).toEqual(["X", "GitHub"]);
    expect(cards[0].get("small").text()).toBe("x.com");
    expect(cards[0].get("a").attributes()).toMatchObject({ href: "https://x.com/jack/status/20", target: "_blank" });
    expect(wrapper.find("button.link-main").exists()).toBe(false);
    expect(wrapper.find(".link-open").exists()).toBe(false);
  });

  it("YouTube 卡片点之前不加载任何东西，点卡片打开全屏播放层", async () => {
    const wrapper = mount(LinkCards, { props: { text: "https://youtu.be/dQw4w9WgXcQ" }, attachTo: document.body });
    expect(document.querySelector("iframe")).toBeNull();
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.get("button.link-main").text()).toContain("点击播放 · YouTube");

    await wrapper.get("button.link-main").trigger("click");

    // Teleported to <body>, outside the chat bubble.
    const viewer = document.body.querySelector<HTMLElement>(":scope > .video-viewer")!;
    expect(viewer.getAttribute("role")).toBe("dialog");
    const iframe = viewer.querySelector("iframe")!;
    expect(iframe.getAttribute("src")).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1");
    expect(iframe.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
    expect(viewer.querySelector("a")!.getAttribute("href")).toBe("https://youtu.be/dQw4w9WgXcQ");

    viewer.querySelector<HTMLButtonElement>(".video-viewer-close")!.click();
    await wrapper.vm.$nextTick();
    expect(document.querySelector(".video-viewer")).toBeNull();
    expect(wrapper.find("button.link-main").exists()).toBe(true);
    wrapper.unmount();
  });

  it("按 Esc 或点黑色背景也能关闭播放层", async () => {
    const wrapper = mount(LinkCards, { props: { text: "https://youtu.be/dQw4w9WgXcQ" }, attachTo: document.body });
    await wrapper.get("button.link-main").trigger("click");
    await wrapper.vm.$nextTick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    expect(document.querySelector(".video-viewer")).toBeNull();

    await wrapper.get("button.link-main").trigger("click");
    document.querySelector<HTMLElement>(".video-viewer")!.click();
    await wrapper.vm.$nextTick();
    expect(document.querySelector(".video-viewer")).toBeNull();
    wrapper.unmount();
  });

  it("视频卡片角落有「在 YouTube 打开」，点它才跳出去", () => {
    const wrapper = mount(LinkCards, { props: { text: "https://youtu.be/dQw4w9WgXcQ" } });
    const open = wrapper.get("a.link-open");
    expect(open.text()).toBe("在 YouTube 打开");
    expect(open.attributes()).toMatchObject({ href: "https://youtu.be/dQw4w9WgXcQ", target: "_blank" });
  });

  it("图片链接点「显示」才加载图片，加载失败就收起", async () => {
    const wrapper = mount(LinkCards, { props: { text: "https://example.com/cat.png" } });
    expect(wrapper.find("img").exists()).toBe(false);

    await wrapper.get("button.link-main").trigger("click");
    expect(wrapper.get("img").attributes("src")).toBe("https://example.com/cat.png");

    await wrapper.get("img").trigger("error");
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.get(".link-card a").attributes("href")).toBe("https://example.com/cat.png");
  });

  it("点卡片上的按钮不会触发外层点击", async () => {
    const outer = vi.fn();
    const wrapper = mount({
      components: { LinkCards },
      template: `<div @click="outer"><LinkCards text="https://youtu.be/dQw4w9WgXcQ" /></div>`,
      setup: () => ({ outer }),
    });
    await wrapper.get("a.link-open").trigger("click");
    await wrapper.get("button.link-main").trigger("click");
    expect(outer).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe("帖子里的视频", () => {
  const youtube = { type: "video", url: "https://youtu.be/dQw4w9WgXcQ", provider: "YouTube", embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ" } as const;

  it("YouTube 先显示播放按钮，点了才加载播放器", async () => {
    const wrapper = mount(VideoPlayer, { props: { videoData: youtube } });
    expect(wrapper.find("iframe").exists()).toBe(false);

    await wrapper.get(".video-facade").trigger("click");

    expect(wrapper.get("iframe").attributes("src")).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1");
    expect(wrapper.get("iframe").attributes("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  });

  it("Vimeo 同样点了才加载", async () => {
    const wrapper = mount(VideoPlayer, { props: { videoData: { type: "video", url: "https://vimeo.com/1", provider: "Vimeo", embedUrl: "https://player.vimeo.com/video/1" } } });
    expect(wrapper.find("iframe").exists()).toBe(false);
    await wrapper.get(".video-facade").trigger("click");
    expect(wrapper.get("iframe").attributes("src")).toBe("https://player.vimeo.com/video/1?autoplay=1");
  });

  it("伪造的嵌入地址不会出现播放按钮", () => {
    const wrapper = mount(VideoPlayer, { props: { videoData: { ...youtube, embedUrl: "https://evil.example/embed" } } });
    expect(wrapper.find(".video-facade").exists()).toBe(false);
    expect(wrapper.find("iframe").exists()).toBe(false);
  });
});

describe("正文里不出现长链接", () => {
  it("普通链接只显示域名，点开仍是完整链接", () => {
    const url = `https://www.tenki.jp/forecast/3/16/4410/13101/?tag=${"x".repeat(60)}`;
    const link = mount(MentionText, { props: { text: url } }).get("a");
    expect(link.attributes("href")).toBe(url);
    expect(link.text()).toBe("tenki.jp");
  });

  it("配了卡片的地方，出卡片的链接从正文里去掉，普通链接留着显示域名", () => {
    const text = "看这个视频 https://youtu.be/dQw4w9WgXcQ ，天气 https://tenki.jp/forecast/3";
    const wrapper = mount(MentionText, { props: { text, hideCardLinks: true } });
    expect(wrapper.text()).toBe("看这个视频，天气 tenki.jp");
    expect(wrapper.findAll("a").map(a => a.attributes("href"))).toEqual(["https://tenki.jp/forecast/3"]);
  });

  it("没配卡片的地方（评论、阅后即焚）链接都留着，只显示域名", () => {
    const wrapper = mount(MentionText, { props: { text: "看 https://youtu.be/dQw4w9WgXcQ" } });
    expect(wrapper.text()).toBe("看 youtu.be");
  });

  it("消息只有一个出卡片的链接时，正文为空", () => {
    const wrapper = mount(MentionText, { props: { text: "https://x.com/jack/status/20", hideCardLinks: true } });
    expect(wrapper.text()).toBe("");
  });
});
