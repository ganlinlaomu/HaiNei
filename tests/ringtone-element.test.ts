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
    expect(unlock).toContain('window.addEventListener("pointerdown", gesture');
    expect(unlock).toContain('if (!event.isTrusted || callAudioActive) return;');
    expect(unlock).toContain('closest?.("[data-live-audio-action]")');
    expect(unlock).toContain('if (session?.type === "play-and-record") return;');
    expect(unlock).not.toContain("SILENT_OFFSET");
    expect(unlock).not.toContain("primeElements");
    expect(readFileSync("src/services/callEngine.ts", "utf8")).toContain('const first = ringtoneElement(kind);');
    expect(readFileSync("src/services/callEngine.ts", "utf8")).toContain('startupMark("call_ring_requires_interaction"');
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
      expect(first.slice(0, 4)).toEqual(Buffer.from("RIFF"));
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
