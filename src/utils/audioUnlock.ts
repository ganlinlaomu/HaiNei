// Ring tones are created only for real calls. Playing a synthetic ringtone on
// arbitrary taps to unlock iOS media can leak an audible burst before the WAV
// has seeked to its silent section, and can steal call/recording audio focus.
// WebRTC playback uses microphone capture and its own AudioSession instead.
const elements = new Map<RingKind, HTMLAudioElement>();
let callAudioActive = false;

export function setCallAudioActive(active: boolean) {
  callAudioActive = active;
}

/** Recording must not reset an active voice call's audio session. */
export function isCallAudioActive() {
  return callAudioActive;
}

export type RingKind = "ring" | "ringback";

/** A looping tone pattern as a small 8 kHz mono 16-bit WAV file. */
export function toneWavBytes(kind: RingKind): Uint8Array {
  const rate = 8_000;
  // ring: two 0.25 s bursts in a 2 s cycle; ringback: 1 s tone, 3 s silence.
  const seconds = kind === "ring" ? 2 : 4;
  const frequency = kind === "ring" ? 660 : 440;
  const on = (t: number) => kind === "ring" ? (t < 0.25 || (t >= 0.5 && t < 0.75)) : t < 1;
  const samples = rate * seconds;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const value = on(t) ? Math.sin(2 * Math.PI * frequency * t) * 0.35 : 0;
    view.setInt16(44 + i * 2, Math.round(value * 32_767), true);
  }
  return new Uint8Array(buffer);
}

/** The same tone as a data URI. */
export function toneWav(kind: RingKind): string {
  let binary = "";
  const bytes = toneWavBytes(kind);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/**
 * A blob URL where possible: an iPhone 15 PWA failed to load the data URI
 * (play() rejected with NotSupportedError) while an iPhone 13 played it.
 */
function toneSource(kind: RingKind) {
  try {
    if (typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function") {
      return URL.createObjectURL(new Blob([toneWavBytes(kind) as BlobPart], { type: "audio/wav" }));
    }
  } catch { /* fall back to the data URI */ }
  return toneWav(kind);
}

/** Recreate an element whose source failed to load (MediaError), once per failure. */
export function reloadRingtoneElement(kind: RingKind): HTMLAudioElement | null {
  const element = elements.get(kind);
  if (element) {
    if (element.src.startsWith("blob:")) URL.revokeObjectURL(element.src);
    elements.delete(kind);
  }
  return ringtoneElement(kind);
}

type BrowserAudioSession = { type: string };

/**
 * Ring through the media ("playback") audio session: Web Audio otherwise uses
 * the ambient session, which the ring/silent switch mutes. "auto" afterwards
 * so the call's microphone session and other audio are unaffected.
 */
export function setRingAudioSession(ringing: boolean) {
  const session = typeof navigator === "undefined" ? undefined
    : (navigator as Navigator & { audioSession?: BrowserAudioSession }).audioSession;
  if (!session) return;
  try { session.type = ringing ? "playback" : "auto"; } catch { /* unsupported */ }
}

export function ringtoneElement(kind: RingKind): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  let element = elements.get(kind);
  if (!element) {
    element = document.createElement("audio");
    // Environments without media playback fall back to Web Audio.
    if (typeof element?.play !== "function" || typeof element?.pause !== "function") return null;
    element.src = toneSource(kind);
    element.loop = true;
    element.preload = "auto";
    element.setAttribute("playsinline", "");
    elements.set(kind, element);
  }
  return element;
}
