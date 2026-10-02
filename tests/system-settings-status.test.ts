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

  it("shows automatic NIP-17 DM relay publication without per-contact connections", () => {
    expect(source).toContain("私信 Relay / kind 10050");
    expect(source).toContain("getOwnDmRelayStatus(account)");
    expect(source).toContain("未找到时兼容传统 Relay");
    expect(source).toContain("不会为每位联系人保持额外长连接");
  });

  it("does not present browser Web Push controls inside the Capacitor Android shell", () => {
    expect(source).toContain('Capacitor?: { isNativePlatform?: () => boolean }');
    expect(source).toContain('后台推送 / {{ isNativeApp ? "Android Push" : "Web Push" }}');
    expect(source).toContain('v-if="!isNativeApp"');
    expect(source).toContain("原生 Push 待启用");
    expect(source).toContain("Android APK 已禁用 PWA Service Worker");
  });

  it("shows how the current private key is protected on this device", () => {
    expect(source).toContain('keyStore.credentialMode === "device"');
    expect(source).toContain('"本机保持登录"');
    expect(source).toContain('"本地密码保护"');
    expect(source).toContain("{{ accountProtectionText }}");
    expect(source).toContain("identity-section");
  });
});
