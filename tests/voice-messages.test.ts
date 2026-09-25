import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import { decryptDmAudio, prepareEncryptedDmAudio } from "@/utils/encryptedDmAudio";
import { parsePrivateAudioMessage, serializePrivateAudioMessage } from "@/nostr/messaging/privateMedia";
import { createVoiceRecordingSession, selectVoiceRecordingMime } from "@/utils/voiceRecorder";

class FakeTrack extends EventTarget {
  kind = "audio";
  readyState: MediaStreamTrackState = "live";
  muted = false;
  stoppedByApp = false;
  stop = vi.fn(() => {
    this.stoppedByApp = true;
    this.readyState = "ended";
  });
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
  mute() {
    this.muted = true;
    this.dispatchEvent(new Event("mute"));
  }
  unmute() {
    this.muted = false;
    this.dispatchEvent(new Event("unmute"));
  }
}

class FakeStream extends EventTarget {
  active = true;
  constructor(public track: FakeTrack) { super(); }
  getAudioTracks() { return [this.track]; }
  getTracks() { return [this.track]; }
  deactivate() {
    this.active = false;
    this.dispatchEvent(new Event("inactive"));
  }
}

class FakeRecorder extends EventTarget {
  static supported = new Set(["audio/mp4", "audio/webm;codecs=opus"]);
  static emitStop = true;
  static emitData = true;
  static stopCalls = 0;
  static startArguments: Array<number | undefined> = [];
  static constructorOptions: Array<MediaRecorderOptions | undefined> = [];
  static instances: FakeRecorder[] = [];
  static isTypeSupported(type: string) { return FakeRecorder.supported.has(type); }
  state: RecordingState = "inactive";
  mimeType = "audio/mp4";
  constructor(public stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    FakeRecorder.constructorOptions.push(options);
    FakeRecorder.instances.push(this);
    if (options?.mimeType) this.mimeType = options.mimeType;
  }
  start(timeslice?: number) {
    FakeRecorder.startArguments.push(timeslice);
    this.state = "recording";
    setTimeout(() => this.dispatchEvent(new Event("start")), 0);
  }
  stop() {
    if (this.state === "inactive") return;
    FakeRecorder.stopCalls += 1;
    this.state = "inactive";
    this.flushFinalRecording();
  }
  unexpectedStop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.flushFinalRecording();
  }
  pause() {
    if (this.state !== "recording") return;
    this.state = "paused";
    this.dispatchEvent(new Event("pause"));
  }
  resume() {
    if (this.state !== "paused") return;
    this.state = "recording";
    this.dispatchEvent(new Event("resume"));
  }
  fail() {
    this.dispatchEvent(new Event("error"));
  }
  private flushFinalRecording() {
    setTimeout(() => this.emitFinalData(), 10);
    if (FakeRecorder.emitStop) setTimeout(() => this.dispatchEvent(new Event("stop")), 20);
  }
  private emitFinalData() {
    const track = (this.stream.getAudioTracks()[0] as unknown as FakeTrack);
    if (!FakeRecorder.emitData || track.stoppedByApp) return;
    const data = new Event("dataavailable") as Event & { data: Blob };
    Object.defineProperty(data, "data", { value: new Blob(["continuous-safari-recording"], { type: this.mimeType }) });
    this.dispatchEvent(data);
  }
}

function recorderHarness() {
  const track = new FakeTrack();
  const fakeStream = new FakeStream(track);
  const stream = fakeStream as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  return { track, stream: fakeStream, getUserMedia };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeRecorder.emitStop = true;
  FakeRecorder.emitData = true;
  FakeRecorder.stopCalls = 0;
  FakeRecorder.startArguments = [];
  FakeRecorder.constructorOptions = [];
  FakeRecorder.instances = [];
});

describe("voice recording lifecycle", () => {
  it("chooses a supported Safari/Chromium MIME without hardcoding one format", () => {
    expect(selectVoiceRecordingMime(FakeRecorder as unknown as typeof MediaRecorder)).toBe("audio/mp4");
    FakeRecorder.supported = new Set(["audio/webm;codecs=opus"]);
    expect(selectVoiceRecordingMime(FakeRecorder as unknown as typeof MediaRecorder)).toBe("audio/webm;codecs=opus");
    expect(selectVoiceRecordingMime({})).toBe("");
    FakeRecorder.supported = new Set(["audio/mp4", "audio/webm;codecs=opus"]);
  });

  it("starts one continuous native recording without a timeslice or forced MIME", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    expect(harness.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeRecorder.startArguments).toEqual([undefined]);
    expect(FakeRecorder.constructorOptions).toEqual([undefined]);
    expect(session.isActive()).toBe(true);
  });

  it("stays active beyond 4, 10, and 30 seconds without internal recorder restarts", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    for (const elapsed of [4_000, 6_000, 20_000]) {
      await vi.advanceTimersByTimeAsync(elapsed);
      expect(session.isActive()).toBe(true);
      expect(harness.track.readyState).toBe("live");
    }
    expect(FakeRecorder.startArguments).toHaveLength(1);
    expect(FakeRecorder.stopCalls).toBe(0);
  });

  it("waits for final dataavailable then stop before constructing a non-empty Blob", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    vi.setSystemTime(4_000);
    const finishing = session.finish();
    expect(harness.track.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.track.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    const result = await finishing;
    expect(result).toMatchObject({ mime: "audio/mp4", duration: 3 });
    expect(result!.size).toBeGreaterThan(0);
    expect(await result!.blob.text()).toBe("continuous-safari-recording");
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("makes Finish idempotent and never calls MediaRecorder.stop twice", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    const first = session.finish();
    const second = session.finish();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(30);
    await expect(first).resolves.toMatchObject({ mime: "audio/mp4" });
    expect(FakeRecorder.stopCalls).toBe(1);
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("rejects and cleans tracks when Safari never dispatches stop", async () => {
    vi.useFakeTimers();
    FakeRecorder.emitStop = false;
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
      stopFallbackMs: 80,
    });
    const finishing = session.finish();
    const rejected = expect(finishing).rejects.toThrow("录音处理超时");
    await vi.advanceTimersByTimeAsync(80);
    await rejected;
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("rejects zero-data recordings and still releases every track", async () => {
    vi.useFakeTimers();
    FakeRecorder.emitData = false;
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    const finishing = session.finish();
    const rejected = expect(finishing).rejects.toThrow("未获取到录音数据");
    expect(harness.track.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("settles an unexpected recorder stop and reports inactive health immediately", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    const health = vi.fn();
    session.onStateChange(health);
    FakeRecorder.instances[0].unexpectedStop();
    expect(session.isActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    await expect(session.finished).resolves.toMatchObject({ size: 27 });
    expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: "stopped", active: false }));
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("exits recording when the microphone track ends", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    harness.track.end();
    expect(session.isActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    await expect(session.finished).resolves.toMatchObject({ mime: "audio/mp4" });
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("freezes elapsed immediately on mute and resumes when unmuted within one second", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    const health = vi.fn();
    session.onStateChange(health);
    await vi.advanceTimersByTimeAsync(2_000);
    harness.track.mute();
    const mutedAt = session.elapsedMs();
    expect(session.isActive()).toBe(false);
    expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ trackMuted: true, active: false }));
    await vi.advanceTimersByTimeAsync(900);
    expect(session.elapsedMs()).toBe(mutedAt);
    harness.track.unmute();
    expect(session.isActive()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.elapsedMs()).toBe(mutedAt + 500);
    expect(FakeRecorder.stopCalls).toBe(0);
  });

  it("interrupts after all live audio tracks stay muted for one second", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    harness.track.mute();
    expect(session.isActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeRecorder.stopCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeRecorder.stopCalls).toBe(1);
    expect(harness.track.readyState).toBe("live");
    await vi.advanceTimersByTimeAsync(20);
    await expect(session.finished).resolves.toMatchObject({ size: 27 });
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("shows the system-interruption error when a muted recording has no usable bytes", async () => {
    vi.useFakeTimers();
    FakeRecorder.emitData = false;
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    harness.track.mute();
    const rejected = expect(session.finished).rejects.toThrow("麦克风录音已被系统中断，请重试");
    await vi.advanceTimersByTimeAsync(1_020);
    await rejected;
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("interrupts when MediaStream.active becomes false", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    harness.stream.deactivate();
    expect(session.isActive()).toBe(false);
    expect(FakeRecorder.stopCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    await expect(session.finished).resolves.toMatchObject({ mime: "audio/mp4" });
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("freezes health/elapsed while paused and resumes the same recorder", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    FakeRecorder.instances[0].pause();
    const pausedAt = session.elapsedMs();
    expect(session.isActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.elapsedMs()).toBe(pausedAt);
    FakeRecorder.instances[0].resume();
    expect(session.isActive()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.elapsedMs()).toBe(pausedAt + 1_000);
    expect(FakeRecorder.startArguments).toHaveLength(1);
  });

  it("cancels without producing a message and dispose cleans up on account switch/unmount", async () => {
    vi.useFakeTimers();
    const first = recorderHarness();
    const cancelled = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: first.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    cancelled.cancel();
    await expect(cancelled.finished).resolves.toBeNull();
    expect(first.track.stop).toHaveBeenCalledOnce();

    const second = recorderHarness();
    const disposed = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: second.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    disposed.dispose();
    await expect(disposed.finished).resolves.toBeNull();
    expect(second.track.stop).toHaveBeenCalledOnce();
  });

  it("automatically finishes at the five-minute limit", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const onAutoFinish = vi.fn();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
      onAutoFinish,
    });
    await vi.advanceTimersByTimeAsync(300_050);
    await expect(session.finished).resolves.toMatchObject({ duration: 300 });
    expect(onAutoFinish).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("releases the microphone and rejects when MediaRecorder errors", async () => {
    vi.useFakeTimers();
    FakeRecorder.emitData = false;
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    const rejected = expect(session.finished).rejects.toThrow("录音失败");
    FakeRecorder.instances[0].fail();
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(session.isActive()).toBe(false);
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });
});

describe("encrypted private audio messages", () => {
  it("serializes only the backward-compatible audio payload metadata", () => {
    const media = { encryptedRef: "blossom+aesgcm:encrypted", mime: "audio/mp4", duration: 12.5, size: 42 };
    const content = serializePrivateAudioMessage(media);
    expect(JSON.parse(content)).toEqual({ type: "audio", media });
    expect(parsePrivateAudioMessage(content)).toEqual({ type: "audio", media });
    expect(parsePrivateAudioMessage('{"type":"audio","media":{"encryptedRef":"blob:raw"}}')).toBeNull();
  });

  it("maps an encrypted reference to locally decrypted playable audio bytes", async () => {
    const prepared = await prepareEncryptedDmAudio(new Blob(["local voice"], { type: "audio/mp4" }), 3);
    expect(new TextDecoder().decode(prepared.encryptedBytes)).not.toContain("local voice");
    const encryptedRef = encodeEncryptedImageRef({
      v: 1, url: "https://media.example/voice", mime: "audio/mp4", alg: "AES-GCM",
      iv: prepared.iv, key: prepared.key,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(prepared.encryptedBytes, { status: 200 })));
    const blob = await decryptDmAudio(encryptedRef);
    expect(blob.type).toBe("audio/mp4");
    expect(await blob.text()).toBe("local voice");
  });

  it("wires playback and route/account cleanup into the conversation without persisting Blob URLs", () => {
    const messages = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const player = readFileSync(join(process.cwd(), "src/components/DmAudioMessage.vue"), "utf8");
    expect(messages).toContain("<DmAudioMessage");
    expect(messages).toContain("cancelVoiceRecording();");
    expect(messages).toContain("const result = await session.finish()");
    expect(messages).not.toContain("session.finished.then");
    expect(messages).toContain("session.onStateChange");
    expect(messages).toContain("session.isActive()");
    expect(messages).toContain("session.elapsedMs()");
    expect(messages).toContain("shallowRef<VoiceRecordingSession");
    expect(messages).toContain("keys.pkHex !== account");
    expect(messages).toContain("peerPubkey.value !== peer");
    expect(messages).toContain("recording.value !== session");
    expect(messages).toContain("URL.createObjectURL(result.blob)");
    expect(messages).toContain('@click="chooseImage"');
    expect(messages).toContain("imageInput.value?.click()");
    expect(messages).toContain('accept="image/*"');
    expect(messages).not.toContain('capture="');
    expect(messages).not.toContain("attachmentMenuOpen");
    expect(messages).not.toContain("attachment-menu");
    expect(messages).toContain("width:calc(100% - 32px)");
    expect(messages).toContain("height:54px;min-height:54px");
    expect(messages).toContain("calc(28px + env(safe-area-inset-bottom))");
    expect(player).toContain("decryptDmAudio");
    expect(player).toContain("URL.revokeObjectURL");
    expect(player).not.toContain("localStorage");
  });
});
