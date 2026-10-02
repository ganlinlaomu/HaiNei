import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("P4 mobile UX regression contract", () => {
  it("keeps browser zoom available on mobile", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain('name="viewport" content="width=device-width,initial-scale=1.0"');
    expect(html).not.toContain("user-scalable=no");
    expect(html).not.toContain("maximum-scale=1");
  });

  it("keeps Pages privacy headers compatible with HTTPS media and WSS relays", () => {
    const headers = readFileSync("public/_headers", "utf8");
    expect(headers).toContain("Content-Security-Policy:");
    expect(headers).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(headers).toContain("connect-src 'self' https: wss:");
    expect(headers).toContain("frame-src https:");
    expect(headers).toContain("Referrer-Policy: no-referrer");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("X-Frame-Options: DENY");
    expect(headers).toContain("Strict-Transport-Security: max-age=31536000");
    expect(headers).toContain("frame-ancestors 'none'");
  });

  it("keeps the new-DM and post composer dialogs keyboard-contained without auto-focusing an input", () => {
    const focus = readFileSync("src/composables/useDialogFocus.ts", "utf8");
    const dm = readFileSync("src/components/NewConversationSheet.vue", "utf8");
    const post = readFileSync("src/components/PostEditorModal.vue", "utf8");

    expect(focus).toContain('if (event.key === "Escape")');
    expect(focus).toContain('if (event.key !== "Tab") return');
    expect(focus).toContain("dialog.value?.focus()");
    expect(focus).toContain("if (trigger?.isConnected) trigger.focus()");
    expect(dm).toContain("useDialogFocus(dialog");
    expect(post).toContain("useDialogFocus(editorCard");
    expect(dm).not.toContain("autofocus");
    expect(post).not.toContain("autofocus");
  });

  it("visually separates forget-account from destructive local-data deletion", () => {
    const login = readFileSync("src/views/Login.vue", "utf8");
    expect(login).toContain('class="account-device-actions"');
    expect(login).toContain("account-device-action-danger");
    expect(login).toContain("保留本机历史数据");
    expect(login).toContain("全部本机资料");
  });

  it("uses generic passkey wording in runtime authentication code", () => {
    const biometric = readFileSync("src/services/biometricUnlock.ts", "utf8");
    const keys = readFileSync("src/stores/keys.ts", "utf8");
    expect(biometric).not.toContain("Face ID");
    expect(keys).not.toContain("Face ID");
    expect(biometric).toContain("通行密钥");
    expect(keys).toContain("通行密钥解锁的私钥与当前账号不匹配");
  });

  it("keeps relay acceptance distinct from delivery and read receipts", () => {
    const messages = readFileSync("src/views/Messages.vue", "utf8");
    expect(messages).toContain('case "sent": return "✓ Relay 已接受"');
    expect(messages).toContain('case "delivered": return "✓✓ 已送达"');
    expect(messages).toContain('case "read": return "✓✓ 已读"');
  });
});
