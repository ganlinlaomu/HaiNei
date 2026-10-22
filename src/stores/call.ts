import { defineStore } from "pinia";
import { ref } from "vue";

export type CallPhase = "idle" | "outgoing" | "incoming" | "connecting" | "active" | "ended";
export type CallEndReason =
  | "hangup" | "remote_hangup" | "declined" | "remote_declined" | "busy" | "remote_busy"
  | "cancelled" | "remote_cancelled" | "no_answer" | "answered_elsewhere" | "failed" | "microphone_denied";

/**
 * Tiny, always-loaded call state for the overlay and the incoming-call
 * signal handler. WebRTC, media and the call screen live in lazily loaded
 * chunks (services/callEngine, components/CallOverlay) so startup is unaffected.
 */
export const useCallStore = defineStore("call", () => {
  const phase = ref<CallPhase>("idle");
  const peer = ref("");
  const callId = ref("");
  const direction = ref<"outgoing" | "incoming">("outgoing");
  /** Invite parameters for an incoming call, kept until accepted or dismissed. */
  const invite = ref<{ room: string; secret: string } | null>(null);
  const connectedAt = ref(0);
  const muted = ref(false);
  const endReason = ref<CallEndReason | null>(null);
  /** Outgoing: a callee device confirmed it is ringing. */
  const remoteRinging = ref(false);
  /** Active call lost its peer and is trying to reconnect. */
  const reconnecting = ref(false);
  /** Recent network quality from WebRTC stats. */
  const quality = ref<"good" | "poor">("good");
  /** Calls already handled, so relay duplicates or a late invite after cancel never ring twice. */
  const seen = new Set<string>();

  function reset() {
    phase.value = "idle";
    peer.value = "";
    callId.value = "";
    invite.value = null;
    connectedAt.value = 0;
    muted.value = false;
    endReason.value = null;
    remoteRinging.value = false;
    reconnecting.value = false;
    quality.value = "good";
  }

  function markSeen(id: string) {
    seen.add(id);
    if (seen.size > 200) seen.delete(seen.values().next().value!);
  }

  return { phase, peer, callId, direction, invite, connectedAt, muted, endReason, remoteRinging, reconnecting, quality, seen, reset, markSeen };
});

/** Lazily load the call engine (WebRTC, Trystero, media). */
export function loadCallEngine() {
  return import("@/services/callEngine");
}
