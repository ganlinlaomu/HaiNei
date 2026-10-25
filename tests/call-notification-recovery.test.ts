import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginCallRecovery, callRecovery, clearRecoveryObservations, dismissCallRecovery, observeRecoverySignal } from "@/services/callNotificationRecovery";
const account = "a".repeat(64), peer = "b".repeat(64), eventId = "c".repeat(64), callId = "d".repeat(32);
const invite = () => ({ account, sender: peer, peer, eventId, createdAt: Math.floor(Date.now()/1000), signal: { action: "invite" as const, callId } });
beforeEach(() => { vi.restoreAllMocks(); dismissCallRecovery(); clearRecoveryObservations(); });
describe("notification recovery from authorized call signals", () => {
  it("matches the clicked encrypted event and ignores unrelated invitations", () => {
    beginCallRecovery(account, { eventId });
    observeRecoverySignal({ ...invite(), eventId: "e".repeat(64) });
    expect(callRecovery.status).toBe("loading");
    observeRecoverySignal(invite());
    expect(callRecovery).toMatchObject({ status: "ready", callId, peer });
  });
  it("uses already observed signals when notification click arrives later", () => {
    observeRecoverySignal(invite()); beginCallRecovery(account, { eventId });
    expect(callRecovery.status).toBe("ready");
  });
  it("reports an expired invitation as ended", () => {
    beginCallRecovery(account, { eventId }); observeRecoverySignal({ ...invite(), createdAt: Math.floor(Date.now()/1000)-46 });
    expect(callRecovery.status).toBe("ended");
  });
  it("handles cancel before invite without pretending a missing invite is ended", () => {
    beginCallRecovery(account, { eventId });
    observeRecoverySignal({ ...invite(), eventId: "e".repeat(64), signal: { action: "cancel", callId } });
    expect(callRecovery.status).toBe("loading");
    observeRecoverySignal(invite()); expect(callRecovery.status).toBe("ended");
  });
  it("reports another device accepting the same call", () => {
    beginCallRecovery(account, { eventId }); observeRecoverySignal(invite());
    observeRecoverySignal({ ...invite(), sender: account, signal: { action: "accept", callId } });
    expect(callRecovery.status).toBe("elsewhere");
  });
  it("isolates accounts and clears peer information on dismiss", () => {
    observeRecoverySignal(invite()); beginCallRecovery(peer, { eventId });
    expect(callRecovery.status).toBe("loading"); expect(callRecovery.peer).toBe("");
    beginCallRecovery(account, { eventId }); dismissCallRecovery();
    expect(callRecovery).toMatchObject({ open: false, peer: "", account: "", eventId: "" });
  });
  it("does not attribute a different peer's terminal event to this call", () => {
    beginCallRecovery(account, { eventId }); observeRecoverySignal(invite());
    observeRecoverySignal({ ...invite(), peer: "f".repeat(64), signal: { action: "cancel", callId } });
    expect(callRecovery.status).toBe("ready");
  });
});
