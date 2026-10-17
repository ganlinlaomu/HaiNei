import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPinia, setActivePinia } from "pinia";
import { getPublicKey } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatLastUsed,
  listDeviceAccounts,
  rememberDeviceAccount,
  updateDeviceAccountPresentation,
} from "@/services/accountRegistry";
import { deviceStorage } from "@/services/deviceStorage";
import { hasDevicePrivateKey, removeDevicePrivateKey } from "@/services/devicePrivateKey";
import { useKeyStore } from "@/stores/keys";
import { biometricMethodLabel } from "@/utils/biometricLabel";
import { hasEncryptedKey } from "@/utils/crypto";

const PRIVATE_KEY = "02".padStart(64, "0");
const PUBKEY = getPublicKey(hexToBytes(PRIVATE_KEY));
const SESSION_KEYS = [
  "hainei_device_accounts", "skHex", "pkHex", "loginMethod", "loginTimestamp",
  "isEncrypted", "credentialMode", "bunkerInput", "bunkerClientSecretKey",
];

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

function createStore() {
  const store = useKeyStore();
  vi.spyOn(store, "loadAccountStores").mockResolvedValue(undefined);
  vi.spyOn(store, "resetAccountStores").mockImplementation(() => undefined);
  return store;
}

beforeEach(async () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  for (const key of [...SESSION_KEYS, `encrypted_sk_${PUBKEY}`]) deviceStorage.removeItem(key);
  await removeDevicePrivateKey(PUBKEY);
  setActivePinia(createPinia());
});

describe("device account presentation", () => {
  it("keeps the remembered name and avatar when a login rewrites the credentials", async () => {
    await rememberDeviceAccount({ pubkey: PUBKEY, authType: "private-key", hasEncryptedKey: false, credentialMode: "device", lastUsedAt: 1 });
    await updateDeviceAccountPresentation(PUBKEY, { displayName: "  小雨  ", avatarThumb: "data:image/jpeg;base64,AAAA" });
    await rememberDeviceAccount({ pubkey: PUBKEY, authType: "private-key", hasEncryptedKey: true, credentialMode: "password", lastUsedAt: 2 });

    expect(listDeviceAccounts()[0]).toMatchObject({
      pubkey: PUBKEY,
      credentialMode: "password",
      displayName: "小雨",
      avatarThumb: "data:image/jpeg;base64,AAAA",
    });
  });

  it("never invents an entry for session-only accounts and drops unsafe thumbnails", async () => {
    await updateDeviceAccountPresentation(PUBKEY, { displayName: "小雨" });
    expect(listDeviceAccounts()).toEqual([]);

    await rememberDeviceAccount({ pubkey: PUBKEY, authType: "private-key", hasEncryptedKey: false, credentialMode: "device", lastUsedAt: 1 });
    await updateDeviceAccountPresentation(PUBKEY, { displayName: "小雨", avatarThumb: "javascript:alert(1)" });
    expect(listDeviceAccounts()[0].avatarThumb).toBeUndefined();
  });

  it("describes the last use in everyday words", () => {
    const now = new Date(2026, 9, 17, 9, 0).getTime();
    expect(formatLastUsed(new Date(2026, 9, 17, 0, 5).getTime(), now)).toBe("今天");
    expect(formatLastUsed(new Date(2026, 9, 16, 23, 59).getTime(), now)).toBe("昨天");
    expect(formatLastUsed(new Date(2026, 9, 13).getTime(), now)).toBe("4 天前");
    expect(formatLastUsed(new Date(2026, 6, 1).getTime(), now)).toBe("7 月 1 日");
    expect(formatLastUsed(0, now)).toBe("很久以前");
  });

  it("names the platform authenticator people recognise", () => {
    expect(biometricMethodLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5)).toBe("Face ID");
    expect(biometricMethodLabel("Mozilla/5.0 (Linux; Android 15)", 5)).toBe("指纹");
    expect(biometricMethodLabel("Mozilla/5.0 (X11; Linux x86_64)", 0)).toBe("通行密钥");
  });
});

describe("login protection moved to Settings › 账号安全", () => {
  it("switches an unlocked account between device, local password and session-only", async () => {
    const store = createStore();
    await store.loginWithNsec(PRIVATE_KEY);
    expect(store.credentialMode).toBe("device");

    await store.protectWithLocalPassword("correct horse");
    expect(store.credentialMode).toBe("password");
    expect(hasEncryptedKey(PUBKEY)).toBe(true);
    expect(await hasDevicePrivateKey(PUBKEY)).toBe(false);
    expect(listDeviceAccounts()[0]).toMatchObject({ credentialMode: "password", hasEncryptedKey: true });

    await store.keepSignedInOnDevice();
    expect(store.credentialMode).toBe("device");
    expect(hasEncryptedKey(PUBKEY)).toBe(false);
    expect(await hasDevicePrivateKey(PUBKEY)).toBe(true);

    await store.useSessionOnlyLogin();
    expect(store.credentialMode).toBe("session");
    expect(store.skHex).toBe(PRIVATE_KEY);
    expect(await hasDevicePrivateKey(PUBKEY)).toBe(false);
    expect(listDeviceAccounts()).toEqual([]);
    expect(deviceStorage.getItem("pkHex")).toBeNull();
  });

  it("rejects short local passwords without touching stored credentials", async () => {
    const store = createStore();
    await store.loginWithNsec(PRIVATE_KEY);
    await expect(store.protectWithLocalPassword("short")).rejects.toThrow("至少需要 8 位");
    expect(store.credentialMode).toBe("device");
    expect(await hasDevicePrivateKey(PUBKEY)).toBe(true);
  });
});

describe("multi-step sign-up flow", () => {
  const login = source("src/views/Login.vue");

  it("keeps the new key in memory until the user taps 进入", () => {
    const next = login.slice(login.indexOf("function continueToBackup"), login.indexOf("async function beginRegistrationBackup"));
    expect(next).toContain("generateSecretKey()");
    expect(next).not.toContain("loginWithNsec");
    expect(next).not.toMatch(/putDeviceValue|storeDevicePrivateKey|localStorage/);

    // Only finishRegistration persists; it is reached from 稍后再说 or a finished Google backup.
    expect(login.match(/await ks\.loginWithNsec\(secretHex\)/g)).toHaveLength(1);
    expect(login).toContain('@skip="finishRegistration"');
    expect(login).toContain('@backed-up="finishRegistration"');
  });

  it("wipes the half-made account when the user leaves the sign-up steps", () => {
    expect(login).toContain("if (!CREATE_STEPS.includes(current)) clearRegistration();");
    expect(login).toMatch(/onBeforeUnmount\(\(\) => \{\s*clearRegistration\(\);/);
    const clear = login.slice(login.indexOf("function clearRegistration"), login.indexOf("function setRegistrationAvatar"));
    expect(clear).toContain('pendingSecretHex.value = ""');
    expect(clear).toContain('generatedNsec.value = ""');
    // A reload loses the in-memory key; never render an empty backup step.
    expect(login).toContain('if (requested === "create-backup" && !pendingSecretHex.value) return "create-name";');
  });

  it("keeps protocol jargon out of the default path and behind 高级", () => {
    for (const file of ["WelcomeScreen.vue", "CreateNameStep.vue"]) {
      expect(source(`src/components/login/${file}`)).not.toMatch(/nsec|relay|NIP|Nostr/i);
    }
    const backup = source("src/components/login/CreateBackupStep.vue");
    const template = backup.slice(0, backup.indexOf("</template>\n\n<script"));
    expect(template.indexOf("{{ nsec }}")).toBeGreaterThan(template.indexOf('v-if="showAdvanced"'));
    expect(backup).toContain("我想自己保存私钥（高级）");
    expect(backup).toContain("随时可在 设置 › 账号安全 中备份");
  });

  it("backs up the key the user already has instead of minting another one", () => {
    const panel = source("src/components/GoogleRecoveryPanel.vue");
    const upload = panel.slice(panel.indexOf("async function uploadExistingAccount"), panel.indexOf("async function createAnotherAccount"));
    expect(upload).toContain("encryptRecoveryPrivateKey(props.backupSecretHex.toLowerCase(), recoveryKey, \"google\")");
    expect(upload).not.toContain("generateSecretKey");
    expect(upload).toContain('emit("backed-up"');
    expect(panel).toContain('phase.value = backups.value.length && !isBackup.value ? "restore-pin" : "setup-pin";');
    expect(panel).toContain("defineExpose({ begin: beginGoogle");
  });

  it("uses SVG line icons instead of emoji on the private key screen", () => {
    const screen = source("src/components/login/PrivateKeyScreen.vue");
    expect(screen).not.toContain("👁");
    expect(screen).toContain(":type=\"visible ? 'text' : 'password'\"");
    expect(screen).toContain("已识别 {{ recognized }} 私钥");
  });

  it("points the scan card at the real Settings entry", () => {
    expect(login).toContain('const DEVICE_PAIR_PATH = "我的 › 设置 › 账户 › 添加设备";');
    const settings = source("src/views/SystemSettings.vue");
    expect(settings).toContain("<h3>账户</h3>");
    expect(settings).toContain("<strong>添加设备</strong>");
  });
});

describe("shared visual tokens", () => {
  it("reuses the app palette and system font while preserving control sizes", () => {
    const styles = source("src/styles.css");
    for (const token of [
      "--hn-bg: var(--bg)", "--hn-primary: var(--accent)", "--hn-secondary-bg: var(--bg-f1f5f9)", "--hn-card: var(--card)",
      "--hn-text: var(--primary)", "--hn-text-2: var(--fg-475569)", "--hn-text-3: var(--fg-64748b)", "--hn-danger: var(--fg-b91c1c)",
      "--hn-danger-bg: var(--bg-fef2f2)", "--hn-success: var(--fg-16803c)", "--hn-control-height: 54px", "--hn-radius-btn: 16px",
      "--hn-radius-input: 14px", "--hn-gutter: 24px",
    ]) expect(styles).toContain(token);
    expect(styles).toContain("--hn-font-sans: var(--font-sans)");
    expect(styles).toContain("--hn-font-brand: var(--font-sans)");
  });
});
