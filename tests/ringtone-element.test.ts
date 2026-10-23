// A fully silent, gesture-activated incoming ring media element is reused later.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { toneWav } from "@/utils/audioUnlock";

function decode(uri: string) {
  expect(uri.startsWith("data:audio/wav;base64,")).toBe(true);
  return Buffer.from(uri.slice("data:audio/wav;base64,".length), "base64");
}

describe("ringtone audio", () => {
  it("generates valid looping 8 kHz WAV tones of the expected length", () => {
    for (const [kind, seconds] of [["ring", 2], ["ringback", 4]] as const) {
      const wav = decode(toneWav(kind));
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(wav.subarray(8, 12).toString()).toBe("WAVE");
      expect(wav.readUInt32LE(24)).toBe(8_000);
      expect(wav.readUInt32LE(40)).toBe(8_000 * seconds * 2);
      // Sound in the first burst, silence at the end of the cycle.
      expect(Math.abs(wav.readInt16LE(44 + 2 * 20))).toBeGreaterThan(0);
      expect(wav.readInt16LE(wav.length - 2)).toBe(0);
    }
  });

  it("registers silent activation only after Vue mounts, never at cold start", () => {
    const unlock = readFileSync("src/utils/audioUnlock.ts", "utf8");
    const main = readFileSync("src/main.ts", "utf8");
    expect(main.indexOf('app.mount("#app")')).toBeLessThan(main.indexOf("installIncomingRingtoneActivation();"));
    expect(unlock).toContain('window.addEventListener("touchend", gesture');
    expect(unlock).toContain('window.addEventListener("pointerup", gesture');
    expect(unlock).toContain('window.addEventListener("keydown", gesture');
    expect(unlock).toContain('window.addEventListener("click", gesture');
    expect(unlock).toContain('(event as PointerEvent).pointerType === "touch"');
    expect(unlock).toContain('if (now - lastGestureAt < 450) return;');
    expect(unlock).toContain('if (!event.isTrusted || callAudioActive || document.visibilityState === "hidden") return;');
    expect(unlock).toContain('closest?.("[data-live-audio-action]")');
    expect(unlock).toContain('if (session?.type === "play-and-record") return;');
    expect(unlock).not.toContain("SILENT_OFFSET");
    expect(unlock).not.toContain("primeElements");
    expect(readFileSync("src/services/callEngine.ts", "utf8")).toContain('const first = ringtoneElement(kind);');
    expect(readFileSync("src/services/callEngine.ts", "utf8")).toContain('startupMark("call_ring_requires_interaction"');
  });

  it("arms on trusted touchend only once and never primes during live audio actions", async () => {
    vi.resetModules();
    const listeners = new Map<string, (event: any) => void>();
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    const audio = {
      src: "", loop: false, preload: "", muted: false, currentTime: 0,
      setAttribute: vi.fn(), play, pause,
    };
    const createElement = vi.fn(() => audio);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      createElement,
      addEventListener: vi.fn((type: string, fn: (event: any) => void) => listeners.set(type, fn)),
    });
    vi.stubGlobal("window", { addEventListener: vi.fn((type: string, fn: (event: any) => void) => listeners.set(type, fn)) });
    vi.stubGlobal("navigator", { audioSession: { type: "auto" } });
    const event = (type: string, opts: Record<string, unknown> = {}) =>
      ({ type, isTrusted: true, target: { closest: () => false }, ...opts });
    try {
      const { installIncomingRingtoneActivation, incomingRingtoneArmed } = await import("@/utils/audioUnlock");
      installIncomingRingtoneActivation();
      listeners.get("pointerup")!(event("pointerup", { pointerType: "touch" }));
      expect(play).not.toHaveBeenCalled();
      listeners.get("touchend")!(event("touchend"));
      listeners.get("click")!(event("click"));
      expect(play).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(incomingRingtoneArmed()).toBe(true);
      expect(pause).toHaveBeenCalledOnce();
      listeners.get("keydown")!(event("keydown", { target: { closest: () => true } }));
      expect(play).toHaveBeenCalledTimes(1);
      listeners.get("visibilitychange")!(event("visibilitychange"));
      // The existing arm is not silently played again until after a new
      // trusted input on foreground. A PWA might have lost its audio route.
      (document as any).visibilityState = "hidden";
      listeners.get("visibilitychange")!(event("visibilitychange"));
      expect(incomingRingtoneArmed()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("a late priming promise cannot pause a real incoming ringtone", async () => {
    vi.resetModules();
    let resolve!: () => void;
    const play = vi.fn(() => new Promise<void>(r => { resolve = r; }));
    const pause = vi.fn();
    const audio = { src: "", loop: false, preload: "", muted: false, currentTime: 0, setAttribute: vi.fn(), play, pause };
    vi.stubGlobal("document", { createElement: () => audio });
    try {
      const { armIncomingRingtoneFromGesture, ringtoneElement, setCallAudioActive, incomingRingtoneArmed } = await import("@/utils/audioUnlock");
      armIncomingRingtoneFromGesture("touchend");
      setCallAudioActive(true);
      expect(ringtoneElement("ring")).toBe(audio);
      expect(audio.loop).toBe(true);
      resolve();
      await Promise.resolve();
      expect(pause).not.toHaveBeenCalled();
      expect(incomingRingtoneArmed()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("primes only with an all-zero clip, then reuses that audio element for a real ring", async () => {
    const { armIncomingRingtoneFromGesture, incomingRingtoneArmed, ringtoneElement } = await import("@/utils/audioUnlock");
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:ringer-${blobs.length}`;
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const play = vi.fn(async () => undefined);
    const pause = vi.fn();
    const audio = {
      src: "", loop: false, preload: "", muted: false, currentTime: 0,
      setAttribute: vi.fn(), play, pause,
    };
    const createElement = vi.fn(() => audio);
    vi.stubGlobal("document", { createElement });
    try {
      armIncomingRingtoneFromGesture();
      expect(play).toHaveBeenCalledTimes(1);
      expect(audio.muted).toBe(false);
      expect(audio.loop).toBe(false);
      expect(blobs.length).toBe(1);
      const first = new Uint8Array(await blobs[0].arrayBuffer());
      expect(Buffer.from(first.slice(0, 4)).toString()).toBe("RIFF");
      expect(Array.from(first.slice(44)).every(sample => sample === 0)).toBe(true);
      await Promise.resolve();
      expect(incomingRingtoneArmed()).toBe(true);
      expect(pause).toHaveBeenCalledOnce();

      const ring = ringtoneElement("ring");
      expect(ring).toBe(audio);
      expect(createElement).toHaveBeenCalledTimes(1);
      expect(audio.loop).toBe(true);
      expect(audio.src).toBe("blob:ringer-2");
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:ringer-1");
      expect(play).toHaveBeenCalledTimes(1); // the call engine, not arming, starts audible playback
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
