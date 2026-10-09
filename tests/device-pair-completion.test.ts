import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { completeDevicePairLogin } from "@/services/devicePairCompletion";

describe("device-pair receiver completion", () => {
  it("routes to Home and shows success without waiting for Worker ACK", async () => {
    const order: string[] = [];
    const blockedAck = new Promise<void>(() => {});
    await completeDevicePairLogin({
      importAccount: async () => { order.push("login"); },
      accountReady: () => { order.push("verify"); return true; },
      acknowledge: () => { order.push("ack"); return blockedAck; },
      onSuccess: () => { order.push("toast"); },
      navigateHome: async () => { order.push("home"); },
    });
    expect(order).toContain("toast");
    expect(order).toContain("home");
    expect(order.indexOf("login")).toBeLessThan(order.indexOf("toast"));
    expect(order.indexOf("verify")).toBeLessThan(order.indexOf("home"));
  });

  it("still shows success and navigates when ACK rejects", async () => {
    const toast = vi.fn();
    const home = vi.fn(async () => {});
    await completeDevicePairLogin({
      importAccount: async () => {},
      accountReady: () => true,
      acknowledge: async () => { throw new Error("offline"); },
      onSuccess: toast,
      navigateHome: home,
    });
    await Promise.resolve();
    expect(toast).toHaveBeenCalledOnce();
    expect(home).toHaveBeenCalledOnce();
  });

  it("never ACKs or announces success when account import fails", async () => {
    const ack = vi.fn();
    const toast = vi.fn();
    const home = vi.fn();
    await expect(completeDevicePairLogin({
      importAccount: async () => { throw new Error("local_vault_unavailable"); },
      accountReady: () => true,
      acknowledge: ack,
      onSuccess: toast,
      navigateHome: home,
    })).rejects.toThrow("local_vault_unavailable");
    expect(ack).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(home).not.toHaveBeenCalled();
  });

  it("requires the expected unlocked account before acknowledging", async () => {
    const ack = vi.fn();
    const toast = vi.fn();
    const home = vi.fn();
    await expect(completeDevicePairLogin({
      importAccount: async () => {},
      accountReady: () => false,
      acknowledge: ack,
      onSuccess: toast,
      navigateHome: home,
    })).rejects.toThrow("pair_login_incomplete");
    expect(ack).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(home).not.toHaveBeenCalled();
  });

  it("preserves one-time session during the keep-alive remount and never awaits ACK before Home", () => {
    const view = readFileSync("src/views/DevicePair.vue", "utf8");
    expect(view).toContain("const pairing = session.value;");
    expect(view).toContain("handoffInProgress = true;");
    expect(view).toContain("if (handoffInProgress) return;");
    expect(view).toContain('ui.addToast("新设备登录成功", 3_200, "success")');
    expect(view).toContain('await router.replace("/")');
    expect(view).not.toContain("await endPair(session.value)");
    expect(view).toContain(':disabled="busy" @click="resetSession"');
  });
});
