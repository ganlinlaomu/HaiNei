// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import type { InboxItem } from "@/stores/messages";
import { MAX_RENDERED_MESSAGES, useChatMessageWindow } from "@/composables/useChatMessageWindow";

// happy-dom has no layout. Model a chat list 500px tall whose rows are all
// 50px, so scroll metrics and row positions follow from the rendered rows.
const ROW = 50;
const VIEWPORT = 500;

const item = (n: number) => ({ id: `m${String(n).padStart(4, "0")}`, pubkey: "p", created_at: n, content: "", tags: [] }) as unknown as InboxItem;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => item(from + i));

function layout(list: HTMLElement) {
  let scrollTop = 0;
  const height = () => list.querySelectorAll(".message-line").length * ROW;
  const clamp = (value: number) => Math.max(0, Math.min(value, Math.max(0, height() - VIEWPORT)));
  Object.defineProperty(list, "clientHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(list, "scrollHeight", { configurable: true, get: height });
  Object.defineProperty(list, "scrollTop", { configurable: true, get: () => scrollTop, set: value => { scrollTop = clamp(value); } });
  list.getBoundingClientRect = () => ({ top: 0, bottom: VIEWPORT }) as DOMRect;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const list = this.closest<HTMLElement>(".message-list");
    const rows = list ? [...list.querySelectorAll(".message-line")] : [];
    const top = rows.indexOf(this) * ROW - (list?.scrollTop ?? 0);
    return { top, bottom: top + ROW, height: ROW } as DOMRect;
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await flushPromises();
  }
}

function setup(initial: InboxItem[], overrides: { exhausted?: boolean; older?: InboxItem[] } = {}) {
  const messages = ref<InboxItem[]>(initial);
  const messageList = ref<HTMLElement | null>(null);
  const searchContextActive = ref(false);
  const searchContextMessages = ref<InboxItem[]>([]);
  const historyExhausted = ref(overrides.exhausted ?? true);
  const retained = ref<string[]>([]);
  const markRead = vi.fn(() => Promise.resolve());
  const onScroll = vi.fn();
  const fetchOlderPage = vi.fn(async () => {
    messages.value = [...(overrides.older ?? []), ...messages.value];
    historyExhausted.value = true;
  });
  let api!: ReturnType<typeof useChatMessageWindow>;

  const Harness = defineComponent({
    setup() {
      api = useChatMessageWindow({
        messages, messageList, peerPubkey: ref("peer"),
        searchContextActive, searchContextMessages,
        sourceFocusReadSuppressed: ref(false), historyExhausted, fetchOlderPage,
        retainedIds: () => retained.value,
        isDisposed: () => false, isLoading: () => false,
        markRead, onScroll,
      });
      return () => h("section", { ref: messageList, class: "message-list", onScroll: api.handleMessageScroll },
        api.windowMessages.value.map(message => h("div", { key: message.id, class: "message-line", "data-message-id": message.id })));
    },
  });
  const wrapper = mount(Harness, { attachTo: document.body });
  layout(messageList.value!);
  const list = messageList.value!;
  const rendered = () => [...list.querySelectorAll<HTMLElement>(".message-line")].map(row => row.dataset.messageId);
  const rowTop = (id: string) => list.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!.getBoundingClientRect().top;
  const scrollTo = async (top: number) => {
    list.scrollTop = top;
    list.dispatchEvent(new Event("scroll"));
    await settle();
  };
  return { wrapper, api, list, messages, searchContextActive, searchContextMessages, retained, markRead, onScroll, fetchOlderPage, rendered, rowTop, scrollTo };
}

describe("聊天消息窗口", () => {
  it("打开长对话只渲染最近 60 条，并停在底部", async () => {
    const t = setup(range(0, 200));
    t.api.setMessageListToBottom();
    await settle();

    expect(t.rendered()).toHaveLength(60);
    expect(t.rendered().at(-1)).toBe("m0199");
    expect(t.list.scrollTop).toBe(60 * ROW - VIEWPORT);
    expect(t.api.showJumpToLatest.value).toBe(false);
  });

  it("在底部时来了新消息：自动跟到底部，标记已读，不出现「回到最新」", async () => {
    const t = setup(range(0, 80));
    t.api.setMessageListToBottom();
    await settle();

    t.messages.value = [...t.messages.value, item(80)];
    await settle();

    expect(t.rendered().at(-1)).toBe("m0080");
    expect(t.list.scrollTop + VIEWPORT).toBe(t.list.scrollHeight);
    expect(t.api.showJumpToLatest.value).toBe(false);
    expect(t.api.pendingTailCount.value).toBe(0);
    expect(t.markRead).toHaveBeenCalled();
  });

  it("往上翻看时来了新消息：位置不动，显示「回到最新」和新消息数", async () => {
    const t = setup(range(0, 80));
    t.api.setMessageListToBottom();
    await settle();
    await t.scrollTo(1_000);
    const topBefore = t.rowTop("m0040");
    t.markRead.mockClear();

    t.messages.value = [...t.messages.value, item(80), item(81)];
    await settle();

    expect(t.list.scrollTop).toBe(1_000);
    expect(t.rowTop("m0040")).toBe(topBefore);
    expect(t.api.showJumpToLatest.value).toBe(true);
    expect(t.api.pendingTailCount.value).toBe(2);
    expect(t.markRead).not.toHaveBeenCalled();
  });

  it("滚到顶部加载更早的消息，当前看到的那一行不跳动，渲染行数有上限", async () => {
    const t = setup(range(0, 300));
    t.api.setMessageListToBottom();
    await settle();
    // At scrollTop 100 the third rendered row sits exactly at the list top.
    const topRow = t.rendered()[2]!;
    await t.scrollTo(2 * ROW);

    expect(t.rendered()[0]).toBe("m0200");
    expect(t.rowTop(topRow)).toBeCloseTo(0);
    expect(t.rendered().length).toBeLessThanOrEqual(MAX_RENDERED_MESSAGES);
  });

  it("已经到本地最早一条时，滚到顶部会去拉历史，拉回来后位置不跳", async () => {
    const t = setup(range(100, 130), { exhausted: false, older: range(0, 100) });
    t.api.setMessageListToBottom();
    await settle();
    expect(t.rendered()[0]).toBe("m0100");

    await t.scrollTo(ROW);

    expect(t.fetchOlderPage).toHaveBeenCalledOnce();
    expect(t.rendered()).toContain("m0099");
    expect(t.rowTop("m0101")).toBeCloseTo(0);
    expect(t.rendered().length).toBeLessThanOrEqual(MAX_RENDERED_MESSAGES);
  });

  it("滚动时关闭长按菜单（onScroll 回调）", async () => {
    const t = setup(range(0, 80));
    t.api.setMessageListToBottom();
    await settle();
    await t.scrollTo(1_000);
    expect(t.onScroll).toHaveBeenCalled();
  });

  it("一帧内多次滚动只处理一次", async () => {
    const t = setup(range(0, 80));
    t.api.setMessageListToBottom();
    await settle();
    t.onScroll.mockClear();
    t.list.scrollTop = 900;
    for (let i = 0; i < 5; i++) t.list.dispatchEvent(new Event("scroll"));
    await settle();
    expect(t.onScroll).toHaveBeenCalledOnce();
  });

  it("窗口外但需要保留的消息（如打开了菜单）仍然渲染", async () => {
    const t = setup(range(0, 200));
    t.api.setMessageListToBottom();
    await settle();
    expect(t.rendered()).not.toContain("m0010");

    t.retained.value = ["m0010"];
    await settle();

    expect(t.rendered()).toContain("m0010");
  });

  it("搜索上下文中显示搜索结果；来了新消息只累计数量", async () => {
    const t = setup(range(0, 80));
    t.api.setMessageListToBottom();
    await settle();

    t.searchContextMessages.value = range(5, 10);
    t.searchContextActive.value = true;
    await settle();
    expect(t.rendered()).toEqual(range(5, 10).map(message => message.id));

    t.messages.value = [...t.messages.value, item(80)];
    await settle();
    expect(t.api.showJumpToLatest.value).toBe(true);
    expect(t.api.pendingTailCount.value).toBe(1);
    expect(t.rendered()).toEqual(range(5, 10).map(message => message.id));
  });

  it("跳到某条消息时把它周围的消息渲染出来", async () => {
    const t = setup(range(0, 300));
    t.api.setMessageListToBottom();
    await settle();

    await t.api.focusWindowOn(20);
    await settle();

    expect(t.rendered()).toContain("m0020");
    expect(t.rendered().length).toBeLessThanOrEqual(MAX_RENDERED_MESSAGES);
    expect(t.api.isTailRendered()).toBe(false);
  });

  it("卸载前取消还没执行的滚动处理", async () => {
    const t = setup(range(0, 80));
    t.api.setMessageListToBottom();
    await settle();
    t.onScroll.mockClear();

    t.list.scrollTop = 900;
    t.list.dispatchEvent(new Event("scroll"));
    t.api.disposeMessageWindow();
    await settle();

    expect(t.onScroll).not.toHaveBeenCalled();
  });
});
