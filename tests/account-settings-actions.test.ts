import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("account actions in Settings", () => {
  it("signs in one account at a time: Settings offers logout, not switch or add", () => {
    const settings = readFileSync(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");
    expect(settings).toContain('<details class="technical-section account-section identity-section">');
    expect(settings).toContain('<summary class="section-heading account-heading">');
    expect(settings).toContain('class="section-heading-icon"');
    expect(settings).not.toContain('<details class="account-section top-level-group">');
    expect(settings).toContain('@click="doLogout"');
    expect(settings).toContain("退出登录");
    expect(settings).toContain("await keyStore.logout()");
    expect(settings).toContain("<p>{{ nickname }} · {{ shortPk }} · {{ accountProtectionText }}</p>");
    // Switching kept the other account signed out of Web Push without the
    // user noticing; one signed-in account means its notifications always work.
    expect(settings).not.toContain("切换账号");
    expect(settings).not.toContain("添加账号");
    expect(settings).not.toContain("AccountSwitcherSheet");
    expect(settings).not.toContain("selectRememberedAccount");
    expect(settings).not.toContain('mode: "add"');
  });

  it("never shows the login page to an unlocked session", () => {
    const router = readFileSync(join(process.cwd(), "src/router/index.ts"), "utf8");
    expect(router).toContain("if (keyStore.isLoggedIn && keyStore.isUnlocked) {");
    expect(router).not.toContain('mode !== "add"');

    const login = readFileSync(join(process.cwd(), "src/views/Login.vue"), "utf8");
    expect(login).not.toContain("addingAccount");
    expect(login).not.toContain("切换账号");
    // The lock screen leaves the current account before another is chosen.
    const leave = login.slice(login.indexOf("async function useAnotherAccount"));
    expect(leave).toContain("await ks.clearActiveSession();");
    expect(login).toContain("退出，登录其他账号");
  });

  it("moves local password and session-only login out of the login page into 账号安全", () => {
    const login = readFileSync(join(process.cwd(), "src/views/Login.vue"), "utf8");
    expect(login).not.toContain("loginStorageMode");
    expect(login).not.toContain("仅此次登录");
    expect(login).toContain("await ks.loginWithNsec(privateKey);");

    const settings = readFileSync(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");
    expect(settings).toContain("<h3>账号安全</h3>");
    expect(settings).toContain("使用本地保护密码");
    expect(settings).toContain("仅此次登录");
    expect(settings).toContain("keyStore.protectWithLocalPassword(password)");
    expect(settings).toContain("keyStore.useSessionOnlyLogin()");
    expect(settings).toContain("keyStore.keepSignedInOnDevice()");
    expect(settings).toContain('mode="backup"');
  });
});
