import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import { decryptDmAudio, prepareEncryptedDmAudio } from "@/utils/encryptedDmAudio";
import { parsePrivateAudioMessage, serializePrivateAudioMessage } from "@/nostr/messaging/privateMedia";
import { createVoiceRecordingSession, selectVoiceRecordingMime } from "@/utils/voiceRecorder";

class FakeRecorder extends EventTarget {
  static supported = new Set(["audio/mp4", "audio/webm;codecs=opus"]);
  static isTypeSupported(type: string) { return FakeRecorder.supported.has(type); }
  state: RecordingState = "inactive";
  mimeType: string;
  constructor(public stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType || "audio/mp4";
  }
  start() { this.state = "recording"; }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const data = new Event("dataavailable") as Event & { data: Blob };
    Object.defineProperty(data, "data", { value: new Blob(["voice"], { type: this.mimeType }) });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event("stop"));
  }
}

function recorderHarness() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  return { stop, getUserMedia };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("voice recording lifecycle", () => {
  it("chooses a supported Safari/Chromium MIME without hardcoding one format", () => {
    expect(selectVoiceRecordingMime(FakeRecorder as unknown as typeof MediaRecorder)).toBe("audio/mp4");
    FakeRecorder.supported = new Set(["audio/webm;codecs=opus"]);
    expect(selectVoiceRecordingMime(FakeRecorder as unknown as typeof MediaRecorder)).toBe("audio/webm;codecs=opus");
    expect(selectVoiceRecordingMime({})).toBe("");
    FakeRecorder.supported = new Set(["audio/mp4", "audio/webm;codecs=opus"]);
  });

  it("starts, finishes, returns a Blob, and stops every media track", async () => {
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
      now: (() => { let value = 1_000; return () => (value += 1_000); })(),
    });
    const result = await session.finish();
    expect(harness.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(result).toMatchObject({ mime: "audio/mp4", size: 5, duration: 1 });
    expect(harness.stop).toHaveBeenCalledOnce();
  });

  it("cancels without producing a message and dispose cleans up on account switch/unmount", async () => {
    const first = recorderHarness();
    const cancelled = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: first.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    cancelled.cancel();
    await expect(cancelled.finished).resolves.toBeNull();
    expect(first.stop).toHaveBeenCalledOnce();

    const second = recorderHarness();
    const disposed = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: second.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    disposed.dispose();
    await expect(disposed.finished).resolves.toBeNull();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("automatically finishes at the five-minute limit", async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const session = await createVoiceRecordingSession({
      mediaDevices: { getUserMedia: harness.getUserMedia } as Pick<MediaDevices, "getUserMedia">,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(session.finished).resolves.toMatchObject({ duration: 300 });
    expect(harness.stop).toHaveBeenCalledOnce();
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
    expect(player).toContain("decryptDmAudio");
    expect(player).toContain("URL.revokeObjectURL");
    expect(player).not.toContain("localStorage");
  });
});
