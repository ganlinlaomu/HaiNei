import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StartupCallSignalGate } from "@/services/startupCallSignalGate";

const me = "a".repeat(64), peer = "b".repeat(64);
const id = "c".repeat(32);
const invite = { action: "invite" as const, callId: id, room: "d".repeat(32), secret: "e".repeat(64) };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); });

describe("cold-start call invite replay gate", () => {
  it("suppresses a cached invite when the cancellation arrives later", () => {
    const now = Math.floor(Date.now() / 1000);
    const gate = new StartupCallSignalGate(me, () => true);
    const delivered = vi.fn();
    gate.accept(peer, me, invite, now - 4, delivered);
    expect(delivered).not.toHaveBeenCalled();
    gate.accept(peer, me, { action: "cancel", callId: id }, now, vi.fn());
    vi.advanceTimersByTime(5_000);
    expect(delivered).not.toHaveBeenCalled();
    gate.dispose();
  });
  it("a signed missed-call record can preempt cached invite without a cancel signal", () => {
    const now = Math.floor(Date.now() / 1000);
    const gate = new StartupCallSignalGate(me, () => true);
    const delivered = vi.fn();
    gate.accept(peer, me, invite, now - 3, delivered);
    gate.conclude(peer, id);
    vi.advanceTimersByTime(5_000);
    expect(delivered).not.toHaveBeenCalled();
    gate.dispose();
  });
  it("still rings a valid unmatched cached invite after the replay grace", () => {
    const now = Math.floor(Date.now() / 1000);
    const gate = new StartupCallSignalGate(me, () => true);
    const delivered = vi.fn();
    gate.accept(peer, me, invite, now - 5, delivered);
    vi.advanceTimersByTime(4_100);
    expect(delivered).toHaveBeenCalledTimes(1);
    gate.dispose();
  });
  it("does not delay a fresh call created after the PWA started", () => {
    const gate = new StartupCallSignalGate(me, () => true);
    const delivered = vi.fn();
    vi.advanceTimersByTime(2_500);
    gate.accept(peer, me, invite, Math.floor(Date.now() / 1000), delivered);
    expect(delivered).toHaveBeenCalledOnce();
    gate.dispose();
  });
  it("scopes terminal calls by peer and cancels outstanding work on account change", () => {
    const now = Math.floor(Date.now() / 1000);
    let active = true;
    const gate = new StartupCallSignalGate(me, () => active);
    const delivered = vi.fn();
    gate.accept(peer, me, invite, now - 2, delivered);
    gate.conclude("f".repeat(64), id);
    active = false;
    vi.advanceTimersByTime(4_100);
    expect(delivered).not.toHaveBeenCalled();
    gate.dispose();
  });
});
