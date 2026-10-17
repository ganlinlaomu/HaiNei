import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("account actions in Settings", () => {
  it("keeps switch, add and logout together in the Account section", () => {
    const settings = readFileSync(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");
    expect(settings).toContain('<details class="technical-section account-section identity-section">');
    expect(settings).toContain('<summary class="section-heading account-heading">');
    expect(settings).toContain('class="account-heading-icon"');
    expect(settings).not.toContain('<details class="account-section top-level-group">');
    expect(settings).toContain('@click="switchAccount"');
    expect(settings).toContain("切换账号");
    expect(settings).toContain('@click="addAccount"');
    expect(settings).toContain("添加账号");
    expect(settings).toContain('@click="doLogout"');
    expect(settings).toContain("退出登录");
    expect(settings).toContain("<p>{{ nickname }} · {{ shortPk }} · {{ accountProtectionText }}</p>");
    expect(settings).toContain("<AccountSwitcherSheet");
    expect(settings).toContain("keyStore.refreshAccounts()");
    expect(settings).toContain("await keyStore.selectRememberedAccount(pubkey)");
    expect(settings).toContain("await keyStore.logout()");
  });

  it("switches between remembered accounts without signing out first", () => {
    const settings = readFileSync(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");
    const switcher = settings.slice(settings.indexOf("async function switchToAccount"), settings.indexOf("function addAccount"));
    // The old flow cleared the session before an account was chosen, so backing
    // out of the login page left the user signed out.
    expect(switcher).not.toContain("clearActiveSession");
    expect(switcher).toContain('if (result === "connected")');
    expect(switcher).toContain('await router.replace({ path: "/login", query: { redirect: "/" } })');
  });

  it("adds an account while staying signed in until the new one is ready", () => {
    const settings = readFileSync(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");
    const add = settings.slice(settings.indexOf("function addAccount"), settings.indexOf("async function beginGoogleBackup"));
    expect(add).not.toContain("clearActiveSession");
    expect(add).toContain('query: { mode: "add", redirect: "/" }');

    const router = readFileSync(join(process.cwd(), "src/router/index.ts"), "utf8");
    expect(router).toContain('keyStore.isLoggedIn && keyStore.isUnlocked && to.query.mode !== "add"');

    const login = readFileSync(join(process.cwd(), "src/views/Login.vue"), "utf8");
    expect(login).toContain('const addingAccount = computed(() => route.query.mode === "add")');
    expect(login).toContain('if (addingAccount.value) return "methods";');
    expect(login).toContain('{ path: "/device-pair", query: { role: "receive" } }');

    const pair = readFileSync(join(process.cwd(), "src/views/DevicePair.vue"), "utf8");
    expect(pair).toContain('keys.isLoggedIn && route.query.role !== "receive"');
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
