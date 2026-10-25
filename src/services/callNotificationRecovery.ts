import { reactive } from "vue";
import type { CallSignal } from "@/nostr/messaging/callControl";
import { CALL_RING_WINDOW_SECONDS } from "@/nostr/messaging/callControl";
export type CallNotice = { eventId?: string; callId?: string; accountScope?: string };
export const callRecovery = reactive({ open: false, account: "", eventId: "", callId: "", peer: "", status: "loading" as "loading" | "unavailable" | "ended" | "elsewhere" | "ready" });
type Observation = { account: string; sender: string; peer: string; eventId: string; signal: CallSignal; createdAt: number };
const observations: Observation[] = [];
export function clearRecoveryObservations() { observations.length = 0; }
export function beginCallRecovery(account: string, notice: CallNotice) {
  Object.assign(callRecovery, { open: true, account, eventId: notice.eventId || "", callId: notice.callId || "", peer: "", status: "loading" });
  resolveCallRecovery();
}
export function dismissCallRecovery() { Object.assign(callRecovery, { open: false, account: "", eventId: "", callId: "", peer: "", status: "loading" }); }
/** Only called after the existing NIP-17 authorization pipeline accepts a call signal. */
export function observeRecoverySignal(value: Observation) {
  observations.push({ ...value, signal: { action: value.signal.action, callId: value.signal.callId } });
  if (observations.length > 64) observations.shift();
  resolveCallRecovery();
}
export function resolveCallRecovery() {
  if (!callRecovery.open || !callRecovery.account) return;
  const records = observations.filter(o => o.account === callRecovery.account);
  const invite = records.find(o => o.signal.action === "invite" && o.sender !== o.account
    && (callRecovery.eventId ? o.eventId === callRecovery.eventId : !!callRecovery.callId && o.signal.callId === callRecovery.callId));
  if (!invite) return;
  callRecovery.callId = invite.signal.callId; callRecovery.peer = invite.peer;
  const terminal = records.find(o => o.signal.callId === invite.signal.callId && o.peer === invite.peer
    && (["cancel", "end", "reject", "busy"].includes(o.signal.action) || o.sender === o.account && o.signal.action === "accept"));
  callRecovery.status = terminal ? terminal.sender === terminal.account ? "elsewhere" : "ended"
    : Date.now() >= (invite.createdAt + CALL_RING_WINDOW_SECONDS) * 1000 ? "ended" : "ready";
}
