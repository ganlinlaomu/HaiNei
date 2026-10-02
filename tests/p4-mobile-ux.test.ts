import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("P4 mobile UX regression contract", () => {
  it("keeps browser zoom available on mobile", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain('name="viewport" content="width=device-width,initial-scale=1.0"');
    expect(html).not.toContain("user-scalable=no");
    expect(html).not.toContain("maximum-scale=1");
  });

  it("prevents iOS PWA input auto-zoom without disabling user zoom", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    const conversations = readFileSync("src/views/Conversations.vue", "utf8");
    const messages = readFileSync("src/views/Messages.vue", "utf8");
    const newDm = readFileSync("src/components/NewConversationSheet.vue", "utf8");
    const friends = readFileSync("src/views/Friends.vue", "utf8");

    expect(styles).toContain("iOS Safari/PWA auto-zooms focused form controls below 16px");
    expect(styles).toMatch(/input\[type="search"\][\s\S]*?textarea,[\s\S]*?select\s*\{\s*font-size:\s*16px;/);
    expect(conversations).toContain("conversation-search input{width:100%;height:42px;padding:0;border:0;outline:0;background:transparent;color:#0f1419;font-size:16px}");
    expect(messages).toContain("chat-search-field input{min-width:0;width:100%;height:38px;padding:0;border:0;outline:0;background:transparent;color:#0f1419;font-size:16px}");
    expect(messages).toContain("searchInput.value?.blur()");
    expect(newDm).toContain("friend-search input{width:100%;height:42px;padding:0;border:0;outline:0;background:transparent;color:#0f1419;font-size:16px}");
    expect(newDm).toContain("if (active instanceof HTMLElement && dialog.value?.contains(active)) active.blur()");
    expect(friends).toMatch(/\.input\s*\{[\s\S]*?font-size:\s*16px;/);
    expect(friends).toContain('if (active instanceof HTMLElement && active.closest(".modal-content")) active.blur()');
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
