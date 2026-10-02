import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("account switch passkey flow", () => {
  it("deduplicates a passkey unlock ceremony at the key-store boundary", () => {
    const keys = source("src/stores/keys.ts");

    expect(keys).toContain("let biometricUnlockFlight:");
    expect(keys).toContain("if (biometricUnlockFlight)");
    expect(keys).toContain("biometricUnlockFlight.account === account");
    expect(keys).toContain("return biometricUnlockFlight.promise");
    expect(keys).toContain('throw new Error("通行密钥验证正在进行，请稍后重试")');
    expect(keys).toContain('this.pkHex.toLowerCase() !== account || this.loginMethod !== "private-key"');
  });

  it("does not let the page-mode watcher trigger biometric auth while account selection is busy", () => {
    const login = source("src/views/Login.vue");

    expect(login).toContain('if (pageMode.value !== "unlock" || loading.value || unlockInProgress.value) return;');
    expect(login).toContain("await presentUnlockMethod()");
  });

  it("returns account switches to Home while add-account can return to settings", () => {
    const settings = source("src/views/SystemSettings.vue");

    expect(settings).toContain('redirect: mode === "switch" ? "/" : "/settings/system"');
  });
});
