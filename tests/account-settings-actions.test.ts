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
    expect(settings).toContain('goToAccountLogin("switch")');
    expect(settings).toContain('goToAccountLogin("add")');
    expect(settings).toContain('redirect: "/settings/system"');
    expect(settings).toContain("await keyStore.clearActiveSession()");
    expect(settings).toContain("keyStore.refreshAccounts()");
    expect(settings).toContain("await keyStore.logout()");
  });

  it("uses the existing secure login UI while keeping add-account separate from switching", () => {
    const login = readFileSync(join(process.cwd(), "src/views/Login.vue"), "utf8");
    expect(login).toContain('const addingAccount = computed(() => route.query.mode === "add")');
    expect(login).toContain('v-if="!addingAccount && ks.accounts.length"');
    expect(login).toContain("添加其他账号");
    expect(login).toContain('addingAccount ? "创建新账号" : "还没有账号？注册"');
    expect(login).toContain("使用私钥登录");
    expect(login).toContain("在本机加密保存私钥");
  });
});
