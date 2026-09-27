import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("System Settings status UX", () => {
  const source = readFileSync(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");

  it("shows useful Relay transport details without changing relay controls", () => {
    expect(source).toContain('<span v-if="relay.read" class="pill">Read</span>');
    expect(source).toContain('<span v-if="relay.write" class="pill">Write</span>');
    expect(source).toContain("最近连接：{{ formatTimestamp(relay.lastConnectedAt) }}");
    expect(source).toContain("@click=\"reconnect(relay.url)\"");
  });

  it("surfaces a compact diagnostics summary and refreshes it from durable state", () => {
    expect(source).toContain("diagnosticsSummary");
    expect(source).toContain("Relay 已连接");
    expect(source).toContain("消息同步");
    expect(source).toContain("最近补拉");
    expect(source).toContain("待发送");
    expect(source).toContain("syncedMessageRepository.getSyncState(account)");
    expect(source).toContain("outgoingQueueRepository.listRetryable(account, true)");
    expect(source).toContain("void refreshDiagnostics()");
  });

  it("does not present browser Web Push controls inside the Capacitor Android shell", () => {
    expect(source).toContain('Capacitor?: { isNativePlatform?: () => boolean }');
    expect(source).toContain('后台推送 / {{ isNativeApp ? "Android Push" : "Web Push" }}');
    expect(source).toContain('v-if="!isNativeApp"');
    expect(source).toContain("原生 Push 待启用");
    expect(source).toContain("Android APK 已禁用 PWA Service Worker");
  });

  it("shows whether the current private key is encrypted on this device", () => {
    expect(source).toContain('keyStore.isEncrypted ? "本机加密保存" : "仅当前会话"');
    expect(source).toContain("{{ accountProtectionText }}");
    expect(source).toContain("identity-section");
  });
});
