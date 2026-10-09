import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("NIP-46 remote signer beta contract", () => {
  it("removes new remote signer login UI without disabling existing signer sessions", () => {
    const login = source("src/views/Login.vue");
    const runtime = source("src/services/nip46RemoteSigner.ts");
    const env = source("src/env.d.ts");

    expect(login).not.toContain('v-if="nip46Enabled"');
    expect(login).not.toContain("openRemoteSignerLogin");
    expect(login).not.toContain("doLoginNip46");
    expect(login).not.toContain("showRemoteSigner");
    expect(login).not.toContain("Bunker URL / NIP-05");
    expect(login).not.toContain("远程签名器（Beta）");
    expect(login).toContain('>扫码登录</button>');
    expect(login).not.toContain("扫描旧设备登录");
    expect(login).toContain("@click=\"router.push('/device-pair')\"");
    expect(login).toContain("accountCredentialLabel(account.authType, account.credentialMode)");
    expect(runtime).toContain('import.meta.env.VITE_ENABLE_NIP46 === "true"');
    expect(env).toContain("VITE_ENABLE_NIP46?: string");
  });

  it("routes signing and NIP-44 through the same remote signer account", () => {
    const keys = source("src/stores/keys.ts");

    expect(keys).toContain('loginMethod: "" as "private-key" | "nip46" | ""');
    expect(keys).toContain('return this.loginMethod === "nip46" && this.isUnlocked');
    expect(keys).toContain("return this.runRemoteSignerOperation(() => remoteNip44Encrypt(account");
    expect(keys).toContain("return this.runRemoteSignerOperation(() => remoteNip44Decrypt(account");
    expect(keys).toContain("const signed = await this.runRemoteSignerOperation(() => remoteSignEvent(account, event))");
    expect(keys).toContain("signed.id !== expectedId");
    expect(keys).toContain("!nostr.verifyEvent(signed)");
  });

  it("persists only an encrypted per-account remote credential and preserves reconnect secret", () => {
    const credential = source("src/services/remoteSignerCredential.ts");
    const runtime = source("src/services/nip46RemoteSigner.ts");

    expect(credential).toContain("wrappingKey: CryptoKey");
    expect(credential).toContain("bunkerSecret: string | null");
    expect(credential).toContain('false,\n    ["encrypt", "decrypt"]');
    expect(credential).toContain("ciphertext: copyBuffer(ciphertext)");
    expect(runtime).toContain("bunkerSecret: pointer.secret");
    expect(runtime).toContain("secret: credential.bunkerSecret");
  });

  it("bounds remote requests and automatically recovers signer sessions", () => {
    const runtime = source("src/services/nip46RemoteSigner.ts");
    const keys = source("src/stores/keys.ts");
    const app = source("src/App.vue");
    const settings = source("src/views/SystemSettings.vue");

    expect(runtime).toContain("const MAX_ACTIVE_OPERATIONS = 2");
    expect(runtime).toContain("const MAX_WAITING_OPERATIONS = 16");
    expect(runtime).toContain("const OPERATION_TIMEOUT_MS = 60_000");
    expect(keys).toContain("async ensureRemoteSignerConnected");
    expect(keys).toContain("async runRemoteSignerOperation<T>");
    expect(keys).toContain("await this.ensureRemoteSignerConnected({ force: true, bypassCooldown: true })");
    expect(keys).toContain("return this.ensureRemoteSignerConnected({ force: true, bypassCooldown: true });");
    expect(keys).not.toContain("await this.loadAccountStores(account, credential.clientSecretHex);");
    expect(app).toContain("prewarmRemoteSignerOnForeground");
    expect(app).toContain("keys.prewarmRemoteSigner()");
    expect(settings).toContain("发送时会自动重连");
    expect(settings).toContain("@click=\"reconnectRemoteSigner\"");
  });

  it("keeps NIP-46 release history while tracking the current package version", () => {
    const pkg = JSON.parse(source("package.json"));
    const changelog = source("CHANGELOG.md");

    expect(changelog).toContain(`## ${pkg.version} —`);
    expect(changelog).toContain("NIP-46 远程签名器 Beta");
  });
});
