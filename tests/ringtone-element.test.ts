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

  it("keeps ringtone priming opt-in to explicit call buttons, not arbitrary app taps", () => {
    const unlock = readFileSync("src/utils/audioUnlock.ts", "utf8");
    const main = readFileSync("src/main.ts", "utf8");
    const chat = readFileSync("src/views/Messages.vue", "utf8");
    expect(main.indexOf('app.mount("#app")')).toBeLessThan(main.indexOf("installIncomingRingtoneActivation();"));
    expect(unlock).toContain('window.addEventListener("touchend", gesture');
    expect(unlock).toContain('window.addEventListener("pointerup", gesture');
    expect(unlock).toContain('window.addEventListener("click", gesture');
    expect(chat).toContain('data-live-audio-action data-ringtone-arm');
    expect(readFileSync("src/components/CallOverlay.vue", "utf8")).toContain('data-live-audio-action data-ringtone-arm');
    expect(readFileSync("src/services/callEngine.ts", "utf8")).toContain('const first = ringtoneElement(kind);');
  });

  it("does not interrupt music on menu changes, even after returning from background", async () => {
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
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, fn: (event: any) => void) => listeners.set(type, fn)),
    });
    vi.stubGlobal("navigator", { audioSession: { type: "auto" } });
    const menuTarget = { closest: () => null };
    const callTarget = { closest: (selector: string) => selector === "[data-ringtone-arm]" ? {} : null };
    const event = (type: string, target: unknown, opts: Record<string, unknown> = {}) =>
      ({ type, isTrusted: true, target, ...opts });
    try {
      const { installIncomingRingtoneActivation, incomingRingtoneArmed, isExplicitRingtoneArmTarget } =
        await import("@/utils/audioUnlock");
      expect(isExplicitRingtoneArmTarget(menuTarget as unknown as EventTarget)).toBe(false);
      expect(isExplicitRingtoneArmTarget(callTarget as unknown as EventTarget)).toBe(true);
      installIncomingRingtoneActivation();
      for (const type of ["pointerup", "touchend", "click", "keydown"]) {
        listeners.get(type)!(event(type, menuTarget, { pointerType: "touch" }));
      }
      expect(play).not.toHaveBeenCalled();
      expect(createElement).not.toHaveBeenCalled();
      expect(incomingRingtoneArmed()).toBe(false);
      // A PWA returning from the background must not reacquire media focus
      // merely because the user changed tabs again.
      (document as any).visibilityState = "hidden";
      listeners.get("visibilitychange")!(event("visibilitychange", menuTarget));
      (document as any).visibilityState = "visible";
      listeners.get("touchend")!(event("touchend", menuTarget));
      expect(play).not.toHaveBeenCalled();

      // Only an intentional voice-call button is allowed to prewarm the ring.
      listeners.get("pointerup")!(event("pointerup", callTarget, { pointerType: "touch" }));
      expect(play).not.toHaveBeenCalled();
      listeners.get("touchend")!(event("touchend", callTarget));
      listeners.get("click")!(event("click", callTarget));
      expect(play).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(incomingRingtoneArmed()).toBe(true);
      expect(pause).toHaveBeenCalledTimes(1);
      // A second navigation tap must not trigger a new prime.
      listeners.get("click")!(event("click", menuTarget));
      expect(play).toHaveBeenCalledTimes(1);
      // Untrusted events must not unlock the element.
      (document as any).visibilityState = "hidden";
      listeners.get("visibilitychange")!(event("visibilitychange", menuTarget));
      (document as any).visibilityState = "visible";
      listeners.get("click")!({ type: "click", target: callTarget, isTrusted: false });
      expect(play).toHaveBeenCalledTimes(1);
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
