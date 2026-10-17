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

  it("explains the DM inbox in plain words and keeps protocol details on the Debug page", () => {
    const settingsTemplate = source.slice(0, source.indexOf("</template>"));
    expect(settingsTemplate).toContain("<div class=\"item-url\">收信地址</div>");
    expect(settingsTemplate).toContain("好友会把私信送到这里，系统自动选择，一般不需要修改。");
    expect(source).toContain("getOwnDmRelayStatus(account)");
    for (const jargon of ["kind 10050", "NIP-17", "NIP-65", "公共目录"]) {
      expect(settingsTemplate.slice(0, settingsTemplate.indexOf("高级设置")), jargon).not.toContain(jargon);
    }
    const debug = readFileSync(join(process.cwd(), "src/views/Debug.vue"), "utf8");
    expect(debug).toContain("私信收件 Relay（kind 10050 / NIP-17）");
    expect(debug).toContain("当前已连接的读取 Relay 中选择最多 2 个接收点");
    expect(debug).toContain("未找到时兼容传统 Relay");
    expect(debug).toContain("不会为每位联系人保持额外长连接");
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
