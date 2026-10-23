// iOS only lets a page make sound after a user gesture. In a home-screen web
// app (standalone PWA) a Web Audio context can even report "running" yet stay
// silent after the app returns from the background, so ringing works in a
// Safari tab but not in the PWA. Ring through <audio> elements instead: each
// is "primed" (played muted and paused) on the first tap, which lets later
// play() calls sound without a gesture. Web Audio stays as a fallback.
let context: AudioContext | null = null;
let installed = false;
const elements = new Map<RingKind, HTMLAudioElement>();
let primed = false;

export type RingKind = "ring" | "ringback";

export function sharedAudioContext(): AudioContext | null {
  return context;
}

/** A looping tone pattern as a small 8 kHz mono WAV data URI. */
export function toneWav(kind: RingKind): string {
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
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

export function ringtoneElement(kind: RingKind): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  let element = elements.get(kind);
  if (!element) {
    element = document.createElement("audio");
    // Environments without media playback fall back to Web Audio.
    if (typeof element?.play !== "function" || typeof element?.pause !== "function") return null;
    element.src = toneWav(kind);
    element.loop = true;
    element.preload = "auto";
    element.setAttribute("playsinline", "");
    elements.set(kind, element);
  }
  return element;
}

function primeElements() {
  for (const kind of ["ring", "ringback"] as const) {
    const element = ringtoneElement(kind);
    if (!element) continue;
    element.muted = true;
    void element.play().then(() => {
      element.pause();
      element.currentTime = 0;
      element.muted = false;
      primed = true;
    }, () => { element.muted = false; });
  }
}

export function ringtonePrimed() {
  return primed;
}

function unlock() {
  try {
    const Context = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Context) {
      context ??= new Context();
      const ctx = context!;
      if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
      // Playing a silent buffer inside the gesture fully unlocks output on iOS.
      const source = ctx.createBufferSource();
      source.buffer = ctx.createBuffer(1, 1, 22_050);
      source.connect(ctx.destination);
      source.start(0);
    }
  } catch {
    // Unsupported: calls still show their screen and system notification.
  }
  if (!primed) primeElements();
}

/** Keep listening: iOS suspends audio again after backgrounding. */
export function installAudioUnlock() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const onGesture = () => { if (!primed || context?.state !== "running") unlock(); };
  for (const type of ["pointerdown", "touchend", "keydown"]) {
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }
}
