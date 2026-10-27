// Hold-to-record moved from Messages.vue into useVoiceRecorder; these pin the
// gesture outcomes (release sends, slide left cancels, slide up locks).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorder = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/utils/voiceRecorder", () => ({ createVoiceRecordingSession: recorder.create }));

import { useVoiceRecorder } from "@/composables/useVoiceRecorder";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const result = { blob: new Blob(["v"]), mime: "audio/webm", duration: 3, size: 1 };

function fakeSession() {
  return {
    mime: "audio/webm", startedAt: 0, finished: Promise.resolve(null),
    finish: vi.fn(async () => result),
    cancel: vi.fn(), dispose: vi.fn(),
    isActive: () => true, elapsedMs: () => 3_000,
    onStateChange: () => () => {},
  };
}

let listeners: Map<string, (event: any) => void>;
beforeEach(() => {
  listeners = new Map();
  vi.stubGlobal("window", {
    addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  vi.stubGlobal("document", { querySelectorAll: () => [] });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => "blob:preview", revokeObjectURL: vi.fn() }));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); recorder.create.mockReset(); });

function setup(options: { pendingImage?: boolean } = {}) {
  const send = vi.fn();
  const voice = useVoiceRecorder({
    account: () => ACCOUNT, peer: () => PEER, accepted: () => true, isDisposed: () => false,
    hasPendingImage: () => !!options.pendingImage, send,
  });
  return { voice, send };
}
const touch = (x: number, y: number) => ({ clientX: x, clientY: y, identifier: 1 });
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe("useVoiceRecorder", () => {
  it("records while held and sends on release", async () => {
    const session = fakeSession();
    recorder.create.mockResolvedValue(session);
    const { voice, send } = setup();
    voice.handleVoiceTouchStart({ changedTouches: [touch(100, 500)] } as any);
    expect(voice.voiceCaptureOwnsAudioSession.value).toBe(true);
    await settle();
    expect(voice.recording.value).toBe(session);
    listeners.get("touchend")!({ changedTouches: [touch(100, 500)], cancelable: true, preventDefault() {} });
    await settle();
    expect(send).toHaveBeenCalledWith(result, ACCOUNT, PEER);
    expect(voice.recording.value).toBeNull();
    expect(voice.voiceCaptureOwnsAudioSession.value).toBe(false);
  });

  it("cancels when slid left before release", async () => {
    const session = fakeSession();
    recorder.create.mockResolvedValue(session);
    const { voice, send } = setup();
    voice.handleVoiceTouchStart({ changedTouches: [touch(200, 500)] } as any);
    await settle();
    listeners.get("touchmove")!({ touches: [touch(100, 500)], cancelable: true, preventDefault() {} });
    expect(voice.voiceGestureHint.value).toBe("cancel");
    listeners.get("touchend")!({ changedTouches: [touch(100, 500)], cancelable: true, preventDefault() {} });
    await settle();
    expect(session.cancel).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("locks when slid up, then keeps a preview instead of sending when finished", async () => {
    const session = fakeSession();
    recorder.create.mockResolvedValue(session);
    const { voice, send } = setup();
    voice.handleVoiceTouchStart({ changedTouches: [touch(200, 500)] } as any);
    await settle();
    listeners.get("touchmove")!({ touches: [touch(200, 400)], cancelable: true, preventDefault() {} });
    listeners.get("touchend")!({ changedTouches: [touch(200, 400)], cancelable: true, preventDefault() {} });
    expect(voice.voiceLocked.value).toBe(true);
    expect(voice.recording.value).toBe(session);
    await voice.finishVoiceRecording();
    expect(send).not.toHaveBeenCalled();
    expect(voice.recordedAudio.value).toMatchObject({ duration: 3, preview: "blob:preview" });
    voice.clearRecordedAudio();
    expect(voice.recordedAudio.value).toBeNull();
  });

  it("drops a capture that finishes starting after the touch was already cancelled", async () => {
    const session = fakeSession();
    let resolve!: (value: unknown) => void;
    recorder.create.mockReturnValue(new Promise(r => { resolve = r; }));
    const { voice } = setup();
    voice.handleVoiceTouchStart({ changedTouches: [touch(200, 500)] } as any);
    await settle();
    listeners.get("touchcancel")!({ cancelable: true, preventDefault() {} });
    resolve(session);
    await settle();
    expect(session.cancel).toHaveBeenCalled();
    expect(voice.recording.value).toBeNull();
  });

  it("does not start while an image is waiting to be sent", () => {
    const { voice } = setup({ pendingImage: true });
    voice.handleVoiceTouchStart({ changedTouches: [touch(200, 500)] } as any);
    expect(recorder.create).not.toHaveBeenCalled();
    expect(voice.voiceCaptureOwnsAudioSession.value).toBe(false);
    expect(voice.formatVoiceDuration(75.9)).toBe("1:15");
  });
});
