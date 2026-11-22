import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSystemSettingsSource } from "./helpers/systemSettingsSource";

describe("System Settings status UX", () => {
  const source = readSystemSettingsSource();

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

  it("has no DM inbox card (kind 10050 is legacy-only) and keeps protocol details on the Debug page", () => {
    // Every user-facing settings template except the Diagnostics section.
    const settingsDir = join(process.cwd(), "src/views/settings");
    const templateOf = (path: string) => { const text = readFileSync(path, "utf8"); return text.slice(0, text.indexOf("</template>")); };
    const settingsTemplate = [join(process.cwd(), "src/views/SystemSettings.vue"),
      ...readdirSync(settingsDir).filter(name => name.endsWith(".vue") && name !== "DiagnosticsSection.vue").map(name => join(settingsDir, name))]
      .map(templateOf).join("\n");
    expect(settingsTemplate).not.toContain("收信地址");
    expect(source).not.toContain("getOwnDmRelayStatus");
    for (const jargon of ["kind 10050", "NIP-17", "NIP-65", "公共目录"]) {
      expect(settingsTemplate, jargon).not.toContain(jargon);
    }
    const debug = readFileSync(join(process.cwd(), "src/views/Debug.vue"), "utf8");
    expect(debug).toContain("<h3>私信 Relay</h3>");
    expect(debug).toContain("都发到「默认 Relay + 写入 Relay」，从「默认 Relay + 读取 Relay」接收");
    expect(debug).toContain("发送时不查询对方的 kind 10050");
    expect(debug).toContain("dmSendRelays()");
    expect(debug).toContain("dmReceiveRelays()");
    expect(debug).toContain("getOwnDmRelayStatus(account)");
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
