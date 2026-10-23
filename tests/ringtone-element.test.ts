// The standalone PWA stayed silent with Web Audio while a Safari tab rang;
// ringing now prefers <audio> elements primed on the first tap.
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

  it("never plays an audible sample on a tap or at app startup", () => {
    const unlock = readFileSync("src/utils/audioUnlock.ts", "utf8");
    const main = readFileSync("src/main.ts", "utf8");
    const engine = readFileSync("src/services/callEngine.ts", "utf8");
    expect(unlock).not.toContain("installAudioUnlock");
    expect(unlock).not.toContain("primeElements");
    expect(unlock).not.toContain("SILENT_OFFSET");
    expect(main).not.toContain("installAudioUnlock");
    expect(main).not.toContain("armIncomingRingtoneOnTap");
    // Taps only arm the incoming ringtone muted, from an idle task.
    expect(unlock).toContain("element.muted = true;");
    expect(unlock).not.toContain("setRingAudioSession(true)");
    expect(readFileSync("src/App.vue", "utf8")).toContain('scheduleBackgroundTask("arm-incoming-ringtone"');
    expect(engine).toContain('ringtoneElement("ringback");');
    expect(engine).toContain('const first = ringtoneElement(kind);');
    expect(engine).toContain('if (name === "NotAllowedError")');
    expect(engine).toContain('startupMark("call_ring_requires_interaction"');
    expect(unlock).toContain("URL.createObjectURL(new Blob([toneWavBytes(kind)");
  });

  it("arms the incoming ringtone muted on a tap so a later call can ring (iOS NotAllowedError)", async () => {
    vi.resetModules();
    const listeners = new Map<string, () => void>();
    const element: any = {
      src: "", loop: false, preload: "", muted: false, paused: true, currentTime: 0, setAttribute: vi.fn(),
      play: vi.fn(async function () { expect(element.muted).toBe(true); }),
      pause: vi.fn(),
    };
    vi.stubGlobal("document", { createElement: () => element, addEventListener: vi.fn(), visibilityState: "visible" });
    vi.stubGlobal("window", { addEventListener: (type: string, fn: () => void) => listeners.set(type, fn) });
    try {
      const { armIncomingRingtoneOnTap } = await import("@/utils/audioUnlock");
      armIncomingRingtoneOnTap();
      expect(element.play).not.toHaveBeenCalled();
      listeners.get("pointerup")!();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(element.play).toHaveBeenCalledTimes(1);
      expect(element.pause).toHaveBeenCalledTimes(1);
      expect(element.muted).toBe(false);
      listeners.get("pointerup")!(); // already armed
      expect(element.play).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("creates a ringtone resource without playing any sample", async () => {
    const { ringtoneElement } = await import("@/utils/audioUnlock");
    const play = vi.fn(async () => undefined);
    const pause = vi.fn();
    const createElement = vi.fn(() => ({
      src: "", loop: false, preload: "", setAttribute: vi.fn(), play, pause,
    }));
    vi.stubGlobal("document", { createElement });
    try {
      const ringtone = ringtoneElement("ring");
      expect(ringtone).toBeTruthy();
      expect(createElement).toHaveBeenCalledTimes(1);
      expect(ringtone?.preload).toBe("auto");
      expect(play).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
