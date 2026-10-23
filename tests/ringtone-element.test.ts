// The standalone PWA stayed silent with Web Audio while a Safari tab rang;
// ringing now prefers <audio> elements primed on the first tap.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

  it("primes the elements on a tap and rings through them before Web Audio", () => {
    const unlock = readFileSync("src/utils/audioUnlock.ts", "utf8");
    // Re-primed after backgrounding and at least every minute, unmuted on silence.
    expect(unlock).toContain('if (document.visibilityState === "hidden") primeStale = true;');
    expect(unlock).toContain("Date.now() - primedAt > REPRIME_AFTER_MS");
    expect(unlock).toContain("element.currentTime = SILENT_OFFSET[kind];");
    expect(unlock).not.toContain("element.muted = true;");
    const engine = readFileSync("src/services/callEngine.ts", "utf8");
    expect(engine.indexOf("const element = ringtoneElement(kind);")).toBeLessThan(engine.indexOf("startWebAudioTone(session, kind, vibration);"));
    expect(engine).toContain('startupMark("call_ring_audio", { kind, via: "element", attempt })');
    // A source that failed to load is rebuilt once, then Web Audio in the media session.
    expect(engine).toContain('name === "NotSupportedError" && attempt === 1 ? reloadRingtoneElement(kind)');
    expect(engine).toContain("setRingAudioSession(true);");
    expect(unlock).toContain("URL.createObjectURL(new Blob([toneWavBytes(kind)");
    expect(unlock.indexOf('ringtoneElement("ring");')).toBeGreaterThan(unlock.indexOf("export function installAudioUnlock"));
    expect(engine).toContain('startupMark("call_ring_audio_failed"');
  });
});
