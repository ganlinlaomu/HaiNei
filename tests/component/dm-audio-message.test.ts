// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import DmAudioMessage from "@/components/DmAudioMessage.vue";

const decryptDmAudio = vi.hoisted(() => vi.fn());
vi.mock("@/utils/encryptedDmAudio", () => ({ decryptDmAudio }));
vi.mock("@/utils/debugLog", () => ({ debugLog: vi.fn() }));

const ACCOUNT = "a".repeat(64);
const media = (ref = "enc:voice-1") => ({ encryptedRef: ref, mime: "audio/mp4" }) as any;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let played: HTMLMediaElement[];

beforeEach(() => {
  played = [];
  decryptDmAudio.mockReset();
  let id = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:voice-${++id}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  // happy-dom has no media pipeline: model just paused/play/pause/load.
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    played.push(this);
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
  });
});

afterEach(() => vi.restoreAllMocks());

function mountVoice(props: Record<string, unknown> = {}) {
  return mount(DmAudioMessage, { props: { media: media(), accountPubkey: ACCOUNT, duration: 7, ...props } });
}

describe("DmAudioMessage 行为", () => {
  it("点击后解密并播放，按钮变成暂停", async () => {
    decryptDmAudio.mockResolvedValue(new Blob(["x"], { type: "audio/mp4" }));
    const wrapper = mountVoice();

    await wrapper.get(".voice-toggle").trigger("click");
    await flushPromises();

    expect(decryptDmAudio).toHaveBeenCalledWith("enc:voice-1", expect.any(AbortSignal));
    expect(wrapper.get("audio").attributes("src")).toBe("blob:voice-1");
    expect(played).toHaveLength(1);
    expect(wrapper.get(".voice-toggle").attributes("aria-label")).toBe("暂停语音");
    expect(wrapper.find(".voice-retry").exists()).toBe(false);
  });

  it("父组件重渲染传入内容相同的新 media 对象，不会打断下载，也不会显示重试", async () => {
    const pending = deferred<Blob>();
    decryptDmAudio.mockReturnValue(pending.promise);
    const wrapper = mountVoice();

    await wrapper.get(".voice-toggle").trigger("click");
    await wrapper.setProps({ media: media() });
    await wrapper.setProps({ media: media(), duration: 7 });
    pending.resolve(new Blob(["x"], { type: "audio/mp4" }));
    await flushPromises();

    const signal = decryptDmAudio.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(played).toHaveLength(1);
    expect(wrapper.find(".voice-retry").exists()).toBe(false);
  });

  it("播放途中父组件重渲染，不会停止播放", async () => {
    decryptDmAudio.mockResolvedValue(new Blob(["x"], { type: "audio/mp4" }));
    const wrapper = mountVoice();
    await wrapper.get(".voice-toggle").trigger("click");
    await flushPromises();

    await wrapper.setProps({ media: media() });

    expect((wrapper.get("audio").element as HTMLMediaElement).paused).toBe(false);
    expect(wrapper.get(".voice-toggle").attributes("aria-label")).toBe("暂停语音");
  });

  it("换成另一条语音会中止旧的下载，且不显示重试", async () => {
    const pending = deferred<Blob>();
    decryptDmAudio.mockReturnValueOnce(pending.promise);
    const wrapper = mountVoice();

    await wrapper.get(".voice-toggle").trigger("click");
    await wrapper.setProps({ media: media("enc:voice-2") });
    const signal = decryptDmAudio.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(true);

    pending.resolve(new Blob(["x"]));
    await flushPromises();
    expect(played).toHaveLength(0);
    expect(wrapper.find(".voice-retry").exists()).toBe(false);
  });

  it("解密失败显示重试，点重试后能正常播放", async () => {
    decryptDmAudio.mockRejectedValueOnce(new Error("network"));
    decryptDmAudio.mockResolvedValueOnce(new Blob(["x"], { type: "audio/mp4" }));
    const wrapper = mountVoice();

    await wrapper.get(".voice-toggle").trigger("click");
    await flushPromises();
    expect(wrapper.get(".voice-retry").text()).toBe("重试");
    expect(played).toHaveLength(0);

    await wrapper.get(".voice-retry").trigger("click");
    await flushPromises();
    expect(decryptDmAudio).toHaveBeenCalledTimes(2);
    expect(played).toHaveLength(1);
    expect(wrapper.find(".voice-retry").exists()).toBe(false);
  });

  it("播放被系统拒绝时显示重试", async () => {
    decryptDmAudio.mockResolvedValue(new Blob(["x"], { type: "audio/mp4" }));
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    const wrapper = mountVoice();

    await wrapper.get(".voice-toggle").trigger("click");
    await flushPromises();

    expect(wrapper.find(".voice-retry").exists()).toBe(true);
    expect(wrapper.get(".voice-toggle").attributes("aria-label")).toBe("播放语音");
  });

  it("再次点击会暂停", async () => {
    decryptDmAudio.mockResolvedValue(new Blob(["x"], { type: "audio/mp4" }));
    const wrapper = mountVoice();
    await wrapper.get(".voice-toggle").trigger("click");
    await flushPromises();

    await wrapper.get(".voice-toggle").trigger("click");
    await flushPromises();

    expect((wrapper.get("audio").element as HTMLMediaElement).paused).toBe(true);
    expect(wrapper.get(".voice-toggle").attributes("aria-label")).toBe("播放语音");
    expect(decryptDmAudio).toHaveBeenCalledTimes(1);
  });

  it("被挂起（如通话中）时按钮不可用，且释放已解密的音频", async () => {
    decryptDmAudio.mockResolvedValue(new Blob(["x"], { type: "audio/mp4" }));
    const wrapper = mountVoice();
    await wrapper.get(".voice-toggle").trigger("click");
    await flushPromises();

    await wrapper.setProps({ suspended: true });

    expect(wrapper.get(".voice-toggle").attributes("disabled")).toBeDefined();
    expect(wrapper.find("audio").exists()).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-1");
  });
});
