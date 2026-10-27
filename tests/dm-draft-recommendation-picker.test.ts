// Drafts and the friend-recommendation picker moved out of Messages.vue.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSSRApp, h, nextTick, ref } from "vue";
import { renderToString } from "vue/server-renderer";
import { createPinia } from "pinia";
import RecommendationPicker from "@/components/RecommendationPicker.vue";
import { useDmDraft } from "@/composables/useDmDraft";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);

function setup(saved: { text?: string; replyTo?: string } | null = null, context: any[] = []) {
  const draft = ref(""), replyingToId = ref(""), draftReplyMessage = ref<any>();
  const directMessages = {
    saveDraft: vi.fn(async () => {}),
    loadDraft: vi.fn(async () => saved),
    loadPeerMessageContext: vi.fn(async () => context),
  };
  const api = useDmDraft({
    account: () => ACCOUNT, peer: () => PEER, isDisposed: () => false, messages: () => [],
    draft, replyingToId, draftReplyMessage, directMessages: directMessages as any,
  });
  return { api, draft, replyingToId, draftReplyMessage, directMessages };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useDmDraft", () => {
  it("does not save before the draft is restored, then saves 300ms after the last edit", async () => {
    const { api, draft, directMessages } = setup();
    draft.value = "early";
    api.scheduleDraftSave();
    await vi.advanceTimersByTimeAsync(1000);
    expect(directMessages.saveDraft).not.toHaveBeenCalled();

    await api.restoreDraft(ACCOUNT, PEER);
    draft.value = "晚";
    api.scheduleDraftSave();
    draft.value = "晚上见";
    api.scheduleDraftSave();
    await vi.advanceTimersByTimeAsync(299);
    expect(directMessages.saveDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(directMessages.saveDraft).toHaveBeenCalledTimes(1);
    expect(directMessages.saveDraft).toHaveBeenCalledWith(PEER, { text: "晚上见", replyTo: undefined }, ACCOUNT);
  });

  it("restores text and a reply target that is outside the loaded window", async () => {
    const quoted = { id: "q1" };
    const { api, draft, replyingToId, draftReplyMessage, directMessages } = setup({ text: "草稿", replyTo: "q1" }, [quoted]);
    await api.restoreDraft(ACCOUNT, PEER);
    expect(draft.value).toBe("草稿");
    expect(replyingToId.value).toBe("q1");
    expect(directMessages.loadPeerMessageContext).toHaveBeenCalledWith(PEER, "q1", 0);
    expect(draftReplyMessage.value).toEqual(quoted);
  });

  it("clears the composer after a send without saving the empty state", async () => {
    const { api, draft, directMessages } = setup();
    await api.restoreDraft(ACCOUNT, PEER);
    draft.value = "要发的话";
    api.scheduleDraftSave();
    api.clearAfterSend(() => { draft.value = ""; });
    api.scheduleDraftSave();
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(directMessages.saveDraft).not.toHaveBeenCalled();
  });

  it("flushes immediately, and stops saving once paused", async () => {
    const { api, draft, directMessages } = setup();
    await api.restoreDraft(ACCOUNT, PEER);
    draft.value = "离开前";
    await api.flushDraft();
    expect(directMessages.saveDraft).toHaveBeenCalledWith(PEER, { text: "离开前", replyTo: undefined }, ACCOUNT);
    api.pauseDraftPersistence();
    draft.value = "锁定后";
    api.scheduleDraftSave();
    await api.flushDraft();
    await vi.advanceTimersByTimeAsync(1000);
    expect(directMessages.saveDraft).toHaveBeenCalledTimes(1);
  });
});

describe("RecommendationPicker", () => {
  const render = (props: Record<string, unknown>) => {
    const app = createSSRApp({
      render: () => h(RecommendationPicker, { peerName: "妈妈", selected: null, candidates: [], query: "", ...props }),
    });
    app.use(createPinia());
    return renderToString(app);
  };

  it("lists candidates, or says there are none", async () => {
    const html = await render({ candidates: [{ pubkey: "c".repeat(64), name: "小李", bio: "" }] });
    expect(html).toContain("将其昵称、简介和公钥加密发送给 妈妈");
    expect(html).toContain("小李");
    expect(html).toContain("暂无简介");
    expect(await render({})).toContain("没有可推荐的好友");
  });

  it("asks to confirm the card snapshot once a friend is selected", async () => {
    const html = await render({ selected: { pubkey: "c".repeat(64), nickname: "小李", bio: "摄影" } });
    expect(html).toContain("确认推荐的名片");
    expect(html).toContain("摄影");
    expect(html).toContain("确认发送");
    expect(html).not.toContain("搜索要推荐的好友");
  });

  it("keeps the confirm button blue: its rule must outrank the shared button rule", () => {
    const source = readFileSync(join(process.cwd(), "src/components/RecommendationPicker.vue"), "utf8");
    expect(source).toContain(".recommendation-confirm-actions .recommendation-confirm-send{background:#1687e8");
    expect(source).not.toMatch(/(^|\n)\.recommendation-confirm-send\{/);
  });
});
