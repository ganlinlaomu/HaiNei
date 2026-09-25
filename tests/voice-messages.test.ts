import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import { decryptDmAudio, prepareEncryptedDmAudio } from "@/utils/encryptedDmAudio";
import { parsePrivateAudioMessage, serializePrivateAudioMessage } from "@/nostr/messaging/privateMedia";
import { createVoiceRecordingSession, selectVoiceRecordingMime } from "@/utils/voiceRecorder";

class FakeRecorder extends EventTarget {
  static supported = new Set(["audio/mp4", "audio/webm;codecs=opus"]);
  static emitStop = true;
  static emitData = true;
  static stopCalls = 0;
  static startTimeslice = 0;
  static isTypeSupported(type: string) { return FakeRecorder.supported.has(type); }
  state: RecordingState = "inactive";
  mimeType: string;
  private interval: ReturnType<typeof setInterval> | null = null;
  private chunkIndex = 0;
  constructor(public stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType || "audio/mp4";
  }
  start(timeslice?: number) {
    this.state = "recording";
    FakeRecorder.startTimeslice = timeslice || 0;
    if (timeslice) this.interval = setInterval(() => this.emitChunk(`slice-${++this.chunkIndex}|`), timeslice);
  }
  stop() {
    if (this.state === "inactive") return;
    FakeRecorder.stopCalls += 1;
    this.state = "inactive";
    if (this.interval) clearInterval(this.interval);
    setTimeout(() => this.emitChunk("final"), 10);
    if (FakeRecorder.emitStop) setTimeout(() => this.dispatchEvent(new Event("stop")), 20);
  }
  private emitChunk(value: string) {
    if (!FakeRecorder.emitData || (this.stream as any).__trackStopped()) return;
    const data = new Event("dataavailable") as Event & { data: Blob };
    Object.defineProperty(data, "data", { value: new Blob([value], { type: this.mimeType }) });
    this.dispatchEvent(data);
  }
}

function recorderHarness() {
  let stopped = false;
  const stop = vi.fn(() => { stopped = true; });
  const stream = {
    getTracks: () => [{ stop }, { stop }],
    __trackStopped: () => stopped,
  } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  return { stop, getUserMedia };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeRecorder.emitStop = true;
  FakeRecorder.emitData = true;
  FakeRecorder.stopCalls = 0;
  FakeRecorder.startTimeslice = 0;
});

describe("voice recording lifecycle", () => {
  it("chooses a supported Safari/Chromium MIME without hardcoding one format", () => {
    expect(selectVoiceRecordingMime(FakeRecorder as unknown as typeof MediaRecorder)).toBe("audio/mp4");
    FakeRecorder.supported = new Set(["audio/webm;codecs=opus"]);
    expect(selectVoiceRecordingMime(FakeRecorder as unknown as typeof MediaRecorder)).toBe("audio/webm;codecs=opus");
    expect(selectVoiceRecordingMime({})).toBe("");
    FakeRecorder.supported = new Set(["audio/mp4", "audio/webm;codecs=opus"]);
  });

  it("awaits asynchronous dataavailable/stop and preserves the final audio chunk", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
      finalChunkGraceMs: 25,
    });
    await vi.advanceTimersByTimeAsync(2_200);
    vi.setSystemTime(4_000);
    const finishing = session.finish();
    expect(FakeRecorder.startTimeslice).toBe(1_000);
    expect(harness.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    const result = await finishing;
    expect(harness.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(result).toMatchObject({ mime: "audio/mp4", duration: 3 });
    expect(result!.size).toBeGreaterThan(0);
    expect(await result!.blob.text()).toBe("slice-1|slice-2|final");
    expect(harness.stop).toHaveBeenCalledTimes(2);
  });

  it("makes Finish idempotent and never calls MediaRecorder.stop twice", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
      finalChunkGraceMs: 5,
    });
    const first = session.finish();
    const second = session.finish();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(30);
    await expect(first).resolves.toMatchObject({ mime: "audio/mp4" });
    expect(FakeRecorder.stopCalls).toBe(1);
    expect(harness.stop).toHaveBeenCalledTimes(2);
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
    expect(harness.stop).toHaveBeenCalledTimes(2);
  });

  it("rejects zero-data recordings and still releases every track", async () => {
    vi.useFakeTimers();
    FakeRecorder.emitData = false;
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
      finalChunkGraceMs: 5,
    });
    const finishing = session.finish();
    const rejected = expect(finishing).rejects.toThrow("未获取到录音数据");
    expect(harness.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    expect(harness.stop).toHaveBeenCalledTimes(2);
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
    expect(first.stop).toHaveBeenCalledTimes(2);

    const second = recorderHarness();
    const disposed = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: second.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    disposed.dispose();
    await expect(disposed.finished).resolves.toBeNull();
    expect(second.stop).toHaveBeenCalledTimes(2);
  });

  it("automatically finishes at the five-minute limit", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const onAutoFinish = vi.fn();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
      finalChunkGraceMs: 25,
      onAutoFinish,
    });
    await vi.advanceTimersByTimeAsync(300_050);
    await expect(session.finished).resolves.toMatchObject({ duration: 300 });
    expect(onAutoFinish).toHaveBeenCalledOnce();
    expect(harness.stop).toHaveBeenCalledTimes(2);
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
    expect(messages).toContain("onAutoFinish:");
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
    expect(player).toContain("decryptDmAudio");
    expect(player).toContain("URL.revokeObjectURL");
    expect(player).not.toContain("localStorage");
  });
});
