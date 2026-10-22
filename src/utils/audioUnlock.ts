// iOS only lets web audio start inside a user gesture. A ringtone created
// when a call arrives (no tap) stayed silent. Unlock one shared AudioContext
// on the first tap and keep it; the call engine rings through it later.
let context: AudioContext | null = null;
let installed = false;

export function sharedAudioContext(): AudioContext | null {
  return context;
}

function unlock() {
  try {
    const Context = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Context) return;
    context ??= new Context();
    const ctx = context!;
    if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
    // Playing a silent buffer inside the gesture fully unlocks output on iOS.
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, 22_050);
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // Unsupported: calls still show their screen and system notification.
  }
}

/** Keep listening: iOS suspends the context again after backgrounding. */
export function installAudioUnlock() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const onGesture = () => { if (context?.state !== "running") unlock(); };
  for (const type of ["pointerdown", "touchend", "keydown"]) {
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }
}
