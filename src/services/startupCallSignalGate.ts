import type { CallSignal } from "@/nostr/messaging/callControl";
import { CALL_RING_WINDOW_SECONDS } from "@/nostr/messaging/callControl";

/**
 * Startup NIP-17 push cache and relay history can deliver an invite before the
 * caller's cancellation. Hold ONLY calls issued before this app boot, allowing
 * already-ended calls to be resolved without flashing the incoming-call UI.
 * Calls placed after startup bypass the gate and ring immediately.
 */
export class StartupCallSignalGate {
  private readonly bootedAt = Date.now();
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; sender: string }>();
  private readonly completed = new Set<string>();
  private stopped = false;

  constructor(private readonly account: string, private readonly isCurrent: () => boolean,
    private readonly graceMs = 4_000) {}

  private key(peer: string, id: string) { return `${peer.toLowerCase()}:${id}`; }

  private drop(key: string) {
    const pending = this.pending.get(key);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(key);
  }

  /** An authenticated caller's missed-call record can precede cancellation. */
  conclude(peer: string, callId: string) {
    if (!peer || !callId || this.stopped) return;
    const key = this.key(peer, callId);
    this.completed.add(key);
    this.drop(key);
    if (this.completed.size > 200) this.completed.delete(this.completed.values().next().value!);
  }

  accept(sender: string, recipient: string, signal: CallSignal, createdAt: number, deliver: () => void) {
    if (this.stopped || !this.isCurrent()) return;
    const fromSelf = sender.toLowerCase() === this.account;
    const peer = fromSelf ? recipient.toLowerCase() : sender.toLowerCase();
    const key = this.key(peer, signal.callId);

    if (!fromSelf && (signal.action === "cancel" || signal.action === "end" || signal.action === "reject")) {
      this.conclude(peer, signal.callId);
    }
    if (signal.action === "invite") {
      if (this.completed.has(key) || this.pending.has(key)) return;
      const now = Date.now();
      const issuedBeforeStartup = createdAt * 1000 <= this.bootedAt + 1_000;
      const stillRinging = createdAt * 1000 + CALL_RING_WINDOW_SECONDS * 1000 > now;
      if (!fromSelf && issuedBeforeStartup && stillRinging) {
        const timer = setTimeout(() => {
          this.pending.delete(key);
          if (!this.stopped && this.isCurrent() && !this.completed.has(key)) deliver();
        }, Math.min(this.graceMs, Math.max(0, createdAt * 1000 + CALL_RING_WINDOW_SECONDS * 1000 - now)));
        this.pending.set(key, { timer, sender: peer });
        return;
      }
    }
    deliver();
  }

  dispose() {
    this.stopped = true;
    for (const key of this.pending.keys()) this.drop(key);
    this.completed.clear();
  }
}
