import { startupMark } from "@/utils/debugLog";

// A user gesture can grant an HTMLAudioElement permission to play later on
// iOS. Prime ONE persistent incoming-ring element using an all-zero PCM clip,
// never a seek into an audible ringtone (which can cause the first-tap "dong").
// Nothing is synthesized or played on the app's cold-start path.
const elements = new Map<RingKind, HTMLAudioElement>();
let callAudioActive = false;
let activationInstalled = false;
let needsIncomingArm = true;
let incomingArmPending = false;
let incomingArmSucceeded = false;
let incomingArmAttempt = 0;
let incomingSilentSource: string | null = null;
let incomingUsingSilence = false;

export function setCallAudioActive(active: boolean) {
  callAudioActive = active;
  if (active) {
    // A pending silent prime must never pause or replace an actual call tone.
    incomingArmAttempt++;
    incomingArmPending = false;
  }
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

/** 0.4 seconds of actual PCM silence, NOT a muted, volume-zero or seeking tone. */
function silentClipSource(): string {
  const rate = 8_000;
  const samples = rate * 0.4;
  const wav = new Uint8Array(44 + samples * 2);
  const view = new DataView(wav.buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF"); view.setUint32(4, wav.length - 8, true);
  write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, wav.length - 44, true);
  try {
    if (typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function") {
      return URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    }
  } catch { /* data URI fallback */ }
  let binary = "";
  for (let i = 0; i < wav.length; i += 0x8000) binary += String.fromCharCode(...wav.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function releaseSilentSource() {
  if (incomingSilentSource?.startsWith("blob:")) {
    try { URL.revokeObjectURL(incomingSilentSource); } catch { /* ignored */ }
  }
  incomingSilentSource = null;
}

export function incomingRingtoneArmed() {
  return incomingArmSucceeded;
}

/**
 * Called synchronously from a real gesture after the Vue UI has mounted.
 * Reuse the EXACT same audio element for the next incoming ringtone.
 * A 100%-silent WAV means loading/seek delays can never leak a tone.
 */
export function armIncomingRingtoneFromGesture(gesture = "manual") {
  if (callAudioActive || typeof document === "undefined" || incomingArmPending || !needsIncomingArm) return;
  const element = elements.get("ring") || document.createElement("audio");
  if (typeof element.play !== "function" || typeof element.pause !== "function") return;
  elements.set("ring", element);
  try {
    // A previous ring may have left its audible source on this element.
    // Invalidate the old media URL only after preparing the zero-sample WAV.
    const nextSource = silentClipSource();
    if (incomingUsingSilence) releaseSilentSource();
    else if (element.src?.startsWith("blob:")) {
      try { URL.revokeObjectURL(element.src); } catch { /* ignored */ }
    }
    incomingSilentSource = nextSource;
    incomingUsingSilence = true;
    element.src = incomingSilentSource;
    element.preload = "auto";
    element.loop = false;
    element.muted = false;
    element.setAttribute("playsinline", "");
    const attempt = ++incomingArmAttempt;
    incomingArmPending = true;
    // IMPORTANT: .play() executes synchronously in the trusted user gesture.
    const playing = Promise.resolve(element.play());
    void playing.then(() => {
      if (attempt !== incomingArmAttempt) return;
      incomingArmPending = false;
      if (callAudioActive || elements.get("ring") !== element || !incomingUsingSilence) return;
      try {
        element.pause();
        element.currentTime = 0;
        needsIncomingArm = false;
        incomingArmSucceeded = true;
        // Only an arm result; a later audible play() can still be denied by WebKit.
        startupMark("ring_arm_result", { result: "primed", gesture });
      } catch {
        needsIncomingArm = true;
        incomingArmSucceeded = false;
        startupMark("ring_arm_result", { result: "pause_failed", gesture });
      }
    }, error => {
      if (attempt !== incomingArmAttempt) return;
      incomingArmPending = false;
      needsIncomingArm = true;
      incomingArmSucceeded = false;
      startupMark("ring_arm_result", { result: "rejected", gesture, error: error instanceof Error ? error.name : "unknown" });
    });
  } catch (error) {
    incomingArmPending = false;
    needsIncomingArm = true;
    incomingArmSucceeded = false;
    startupMark("ring_arm_result", { result: "exception", gesture, error: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * Only capture gestures WebKit recognizes as media activations. On iOS, the
 * pointerup preceding touchend is deliberately ignored so it cannot consume
 * the only activation opportunity with an early rejected play(). Native
 * keyboard, mouse/pen and assistive click actions remain supported.
 */
export function installIncomingRingtoneActivation() {
  if (activationInstalled || typeof window === "undefined") return;
  activationInstalled = true;
  let lastGestureAt = -Infinity;
  const gesture = (event: Event) => {
    if (!event.isTrusted || callAudioActive || document.visibilityState === "hidden") return;
    if (event.type === "pointerup" && (event as PointerEvent).pointerType === "touch") return;
    if ((event.target as Element | null)?.closest?.("[data-live-audio-action]")) return;
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session?.type === "play-and-record") return;
    // touchend + synthetic click from the same gesture must not cause two
    // consecutive play() attempts if the first settles unusually quickly.
    const now = Date.now();
    if (now - lastGestureAt < 450) return;
    if (incomingArmPending || !needsIncomingArm) return;
    lastGestureAt = now;
    armIncomingRingtoneFromGesture(event.type);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      ++incomingArmAttempt;
      incomingArmPending = false;
      needsIncomingArm = true;
      incomingArmSucceeded = false;
    }
  });
  window.addEventListener("touchend", gesture, { capture: true, passive: true });
  window.addEventListener("pointerup", gesture, { capture: true, passive: true });
  window.addEventListener("keydown", gesture, { capture: true });
  window.addEventListener("click", gesture, { capture: true });
}

/** Recreate an element whose source failed to load (MediaError), once per failure. */
export function reloadRingtoneElement(kind: RingKind): HTMLAudioElement | null {
  const element = elements.get(kind);
  if (element) {
    ++incomingArmAttempt;
    incomingArmPending = false;
    if (kind === "ring") {
      incomingUsingSilence = false;
      incomingArmSucceeded = false;
      needsIncomingArm = true;
      releaseSilentSource();
    }
    if (element.src.startsWith("blob:")) {
      try { URL.revokeObjectURL(element.src); } catch { /* ignored */ }
    }
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
  try {
    // An in-progress voice recording or call already owns play-and-record.
    // Its audio category must never be downgraded just to ring.
    if (ringing && session.type !== "play-and-record") session.type = "playback";
    // Only release the ringtone's own playback category, not a newer call's.
    if (!ringing && session.type === "playback") session.type = "auto";
  } catch { /* unsupported */ }
}

export function ringtoneElement(kind: RingKind): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  let element = elements.get(kind);
  if (!element) {
    element = document.createElement("audio");
    if (typeof element?.play !== "function" || typeof element?.pause !== "function") return null;
    element.src = toneSource(kind);
    element.loop = true;
    element.preload = "auto";
    element.setAttribute("playsinline", "");
    elements.set(kind, element);
  } else if (kind === "ring" && incomingUsingSilence) {
    // Switch the already-gesture-activated element to its real ring source;
    // swapping source retains its identity. No new HTMLAudioElement is made.
    ++incomingArmAttempt;
    incomingArmPending = false;
    incomingUsingSilence = false;
    const old = incomingSilentSource;
    element.src = toneSource("ring");
    element.loop = true;
    if (old) releaseSilentSource();
  }
  return element;
}
