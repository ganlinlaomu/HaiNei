// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { BurnDuration } from "@/nostr/messaging/disappearingMessages";
import type { SelectedDmImage } from "@/composables/useDmImageSelection";
import { useDmComposerActions } from "@/composables/useDmComposerActions";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const location = { lat: 35.68, lng: 139.76, accuracy: 10, at: 1_700_000_000 };
const voice = (duration = 3) => ({ blob: new Blob(["v"]), mime: "audio/mp4", duration, size: 1 });
const image = (name: string): SelectedDmImage => ({ file: new File([name], name, { type: "image/jpeg" }), preview: `blob:${name}` });

function setup(overrides: { accepted?: boolean; nip44?: boolean } = {}) {
  const state = {
    account: ACCOUNT,
    peer: PEER,
    accepted: overrides.accepted ?? true,
    nip44: overrides.nip44 ?? true,
    disposed: false,
    replyTarget: undefined as string | undefined,
  };
  const draft = ref("");
  const replyingToId = ref("");
  const selectedImages = ref<SelectedDmImage[]>([]);
  const recording = ref<unknown>(null);
  const recordedAudio = ref<ReturnType<typeof voice> | null>(null);
  const voiceError = ref("");
  const voiceCaptureOwnsAudioSession = ref(false);
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  const fileInput = document.createElement("input");
  const disappearingSeconds = ref<BurnDuration | null>(null);
  const attachmentMenuOpen = ref(true);
  const locationSheetOpen = ref(false);
  const spies = {
    cancelReply: vi.fn(() => { replyingToId.value = ""; state.replyTarget = undefined; }),
    clearSelectedImages: vi.fn(() => { selectedImages.value = []; }),
    clearRecordedAudio: vi.fn(() => { recordedAudio.value = null; }),
    showRecommendationPicker: vi.fn(),
    clearAfterSend: vi.fn((clear: () => void) => clear()),
    send: vi.fn(),
    sendAudio: vi.fn(),
    startLiveSharing: vi.fn(() => Promise.resolve()),
    notify: vi.fn(),
    click: vi.spyOn(fileInput, "click").mockImplementation(() => {}),
  };
  const actions = useDmComposerActions({
    account: () => state.account,
    peer: () => state.peer,
    accepted: () => state.accepted,
    supportsNip44: () => state.nip44,
    isDisposed: () => state.disposed,
    draft, replyingToId,
    replyTarget: () => state.replyTarget,
    cancelReply: spies.cancelReply,
    selectedImages, imageInput: ref(fileInput), clearSelectedImages: spies.clearSelectedImages,
    recording, recordedAudio, clearRecordedAudio: spies.clearRecordedAudio, voiceError, voiceCaptureOwnsAudioSession,
    textInput: ref(textarea), disappearingSeconds, attachmentMenuOpen, locationSheetOpen,
    showRecommendationPicker: spies.showRecommendationPicker,
    clearAfterSend: spies.clearAfterSend,
    directMessages: { send: spies.send, sendAudio: spies.sendAudio } as any,
    startLiveSharing: spies.startLiveSharing,
    notify: spies.notify,
  });
  const replyTo = (id: string) => { replyingToId.value = id; state.replyTarget = id; };
  return {
    state, actions, spies, draft, replyTo, replyingToId, selectedImages, recording, recordedAudio, voiceError,
    voiceCaptureOwnsAudioSession, textarea, disappearingSeconds, attachmentMenuOpen, locationSheetOpen,
  };
}

describe("私信发送", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it("发送文字（带引用），发完清空输入框和引用", () => {
    t.draft.value = "你好";
    t.replyTo("msg-1");

    t.actions.submitMessage();

    expect(t.spies.send).toHaveBeenCalledWith(PEER, "你好", undefined, "msg-1", undefined);
    expect(t.draft.value).toBe("");
    expect(t.spies.cancelReply).toHaveBeenCalled();
    expect(t.attachmentMenuOpen.value).toBe(false);
  });

  it("只有空格、对方未接受好友、正在录音时都不能发送", () => {
    t.draft.value = "   ";
    expect(t.actions.canSend.value).toBe(false);
    t.actions.submitMessage();
    expect(t.spies.send).not.toHaveBeenCalled();

    t.draft.value = "hi";
    t.recording.value = {};
    expect(t.actions.canSend.value).toBe(false);

    const stranger = setup({ accepted: false });
    stranger.draft.value = "hi";
    expect(stranger.actions.canSend.value).toBe(false);
  });

  it("多张图片每张一条消息，文字和引用只跟第一张", () => {
    t.draft.value = "看看";
    t.replyTo("msg-1");
    t.selectedImages.value = [image("a.jpg"), image("b.jpg"), image("c.jpg")];
    const [a, b, c] = t.selectedImages.value.map(selected => selected.file);

    t.actions.submitMessage();

    expect(t.spies.send.mock.calls).toEqual([
      [PEER, "看看", a, "msg-1"],
      [PEER, "", b, undefined],
      [PEER, "", c, undefined],
    ]);
    expect(t.selectedImages.value).toEqual([]);
    expect(t.draft.value).toBe("");
  });

  it("只有图片没有文字也能发送", () => {
    t.selectedImages.value = [image("a.jpg")];
    expect(t.actions.canSend.value).toBe(true);
    t.actions.submitMessage();
    expect(t.spies.send).toHaveBeenCalledOnce();
  });

  it("阅后即焚发送文字时带上时长，发完退出阅后即焚", () => {
    t.actions.enableDisappearing();
    t.draft.value = "秘密";

    t.actions.submitMessage();

    expect(t.spies.send).toHaveBeenCalledWith(PEER, "秘密", undefined, undefined, 10);
    expect(t.disappearingSeconds.value).toBeNull();
  });

  it("阅后即焚不能带图片或引用", () => {
    t.disappearingSeconds.value = 10;
    t.draft.value = "x";
    t.selectedImages.value = [image("a.jpg")];
    t.actions.submitMessage();

    t.selectedImages.value = [];
    t.replyTo("msg-1");
    t.actions.submitMessage();

    expect(t.spies.send).not.toHaveBeenCalled();
    expect(t.spies.notify).toHaveBeenCalledTimes(2);
    expect(t.spies.notify).toHaveBeenCalledWith("阅后即焚仅支持纯文字消息", 2200, "info");
    expect(t.draft.value).toBe("x");
  });

  it("发送录好的语音（带引用），发完清掉录音", () => {
    const audio = voice();
    t.recordedAudio.value = audio;
    t.replyTo("msg-1");

    t.actions.submitMessage();

    expect(t.spies.sendAudio).toHaveBeenCalledWith(PEER, audio, "msg-1");
    expect(t.spies.send).not.toHaveBeenCalled();
    expect(t.recordedAudio.value).toBeNull();
  });

  it("发送失败时提示错误，保留输入内容和图片", () => {
    t.spies.send.mockImplementation(() => { throw new Error("账号已锁定"); });
    t.draft.value = "你好";
    t.selectedImages.value = [image("a.jpg")];

    t.actions.submitMessage();

    expect(t.spies.notify).toHaveBeenCalledWith("账号已锁定", 2200, "error");
    expect(t.draft.value).toBe("你好");
    expect(t.selectedImages.value).toHaveLength(1);
  });

  it("语音发送失败时提示并记下错误", () => {
    t.spies.sendAudio.mockImplementation(() => { throw new Error("太大了"); });
    t.recordedAudio.value = voice();

    t.actions.submitMessage();

    expect(t.voiceError.value).toBe("太大了");
    expect(t.spies.notify).toHaveBeenCalledWith("太大了", 2200, "error");
    expect(t.recordedAudio.value).not.toBeNull();
  });
});

describe("按住说话松开后发送", () => {
  it("正常发送并清掉引用", () => {
    const t = setup();
    t.replyTo("msg-1");
    const result = voice(3);
    t.actions.sendVoiceRecordingResult(result, ACCOUNT, PEER);
    expect(t.spies.sendAudio).toHaveBeenCalledWith(PEER, result, "msg-1");
    expect(t.spies.cancelReply).toHaveBeenCalled();
  });

  it("不足 1 秒提示「说话时间太短」，不发送", () => {
    const t = setup();
    t.actions.sendVoiceRecordingResult(voice(0.4), ACCOUNT, PEER);
    expect(t.spies.sendAudio).not.toHaveBeenCalled();
    expect(t.spies.notify).toHaveBeenCalledWith("说话时间太短", 1_600, "info");
  });

  it("录音期间切换了聊天、账号或离开页面，录音丢弃", () => {
    const t = setup();
    t.state.peer = "c".repeat(64);
    t.actions.sendVoiceRecordingResult(voice(), ACCOUNT, PEER);
    t.state.peer = PEER;
    t.state.account = "d".repeat(64);
    t.actions.sendVoiceRecordingResult(voice(), ACCOUNT, PEER);
    t.state.account = ACCOUNT;
    t.state.disposed = true;
    t.actions.sendVoiceRecordingResult(voice(), ACCOUNT, PEER);
    expect(t.spies.sendAudio).not.toHaveBeenCalled();
    expect(t.spies.notify).not.toHaveBeenCalled();
  });
});

describe("附件菜单", () => {
  it("开启阅后即焚：取消引用、设为 10 秒、聚焦输入框", async () => {
    const t = setup();
    t.replyTo("msg-1");
    t.actions.enableDisappearing();
    await nextTick();
    expect(t.disappearingSeconds.value).toBe(10);
    expect(t.replyingToId.value).toBe("");
    expect(document.activeElement).toBe(t.textarea);
    expect(t.attachmentMenuOpen.value).toBe(false);
  });

  it("已选图片、录音或正在录音时不能开启阅后即焚", () => {
    for (const prepare of [
      (t: ReturnType<typeof setup>) => { t.selectedImages.value = [image("a.jpg")]; },
      (t: ReturnType<typeof setup>) => { t.recordedAudio.value = voice(); },
      (t: ReturnType<typeof setup>) => { t.voiceCaptureOwnsAudioSession.value = true; },
    ]) {
      const t = setup();
      prepare(t);
      t.actions.enableDisappearing();
      expect(t.disappearingSeconds.value).toBeNull();
      expect(t.spies.notify).toHaveBeenCalledWith("请先移除图片或语音，阅后即焚仅支持文字", 2200, "info");
    }
  });

  it("账号不支持 NIP-44 时不能开启阅后即焚，也不能发好友名片", () => {
    const t = setup({ nip44: false });
    t.actions.enableDisappearing();
    t.actions.openRecommendationPicker();
    expect(t.disappearingSeconds.value).toBeNull();
    expect(t.spies.showRecommendationPicker).not.toHaveBeenCalled();
    expect(t.spies.notify).toHaveBeenCalledWith("当前账号无法发送加密临时消息", 2000, "info");
    expect(t.spies.notify).toHaveBeenCalledWith("当前账号无法发送加密好友名片", 2000, "info");
  });

  it("阅后即焚时不能选图片、发位置或好友名片", () => {
    const t = setup();
    t.disappearingSeconds.value = 10;
    t.actions.chooseImageFromMenu();
    t.actions.openLocationSheet();
    t.actions.openRecommendationPicker();
    expect(t.spies.click).not.toHaveBeenCalled();
    expect(t.locationSheetOpen.value).toBe(false);
    expect(t.spies.showRecommendationPicker).not.toHaveBeenCalled();
  });

  it("平时可以选图片、打开位置面板和好友名片", () => {
    const t = setup();
    t.actions.chooseImageFromMenu();
    expect(t.spies.click).toHaveBeenCalledOnce();
    t.actions.openLocationSheet();
    expect(t.locationSheetOpen.value).toBe(true);
    t.actions.openRecommendationPicker();
    expect(t.spies.showRecommendationPicker).toHaveBeenCalledOnce();
  });
});

describe("发送位置", () => {
  it("发送当前位置是单独一条消息，不影响正在输入的内容", async () => {
    const t = setup();
    t.draft.value = "草稿";
    t.locationSheetOpen.value = true;

    await t.actions.sendLocation(location);

    expect(t.spies.send).toHaveBeenCalledOnce();
    const [peer, content, file, reply, burn, options] = t.spies.send.mock.calls[0];
    expect([peer, file, reply, burn, options]).toEqual([PEER, undefined, undefined, undefined, { preserveDraft: true }]);
    expect(content).toContain("35.68");
    expect(t.draft.value).toBe("草稿");
    expect(t.locationSheetOpen.value).toBe(false);
  });

  it("实时共享位置走共享接口，失败时提示", async () => {
    const t = setup();
    await t.actions.sendLocation(location, 900);
    expect(t.spies.startLiveSharing).toHaveBeenCalledWith(PEER, 900, location);
    expect(t.spies.send).not.toHaveBeenCalled();

    t.spies.startLiveSharing.mockRejectedValueOnce(new Error("定位权限被拒绝"));
    await t.actions.sendLocation(location, 900);
    expect(t.spies.notify).toHaveBeenCalledWith("定位权限被拒绝", 2200, "error");
  });
});
