import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("passkey quick login", () => {
  it("keeps biometric unlock local and requires platform user verification", () => {
    const biometric = readFileSync(join(process.cwd(), "src/services/biometricUnlock.ts"), "utf8");
    expect(biometric).toContain('authenticatorAttachment: "platform"');
    expect(biometric).toContain('userVerification: "required"');
    expect(biometric).toContain("prf:");
    expect(biometric).toContain("evalByCredential");
    expect(biometric).toContain('navigator.credentials.get({ publicKey: request })');
    expect(biometric).toContain('navigator.credentials.create({ publicKey: creation })');
    expect(biometric).not.toContain("fetch(");
    expect(biometric).not.toContain("Face ID");
  });

  it("auto-attempts passkey verification and auto-submits password autofill as fallback", () => {
    const login = readFileSync(join(process.cwd(), "src/views/Login.vue"), "utf8");
    expect(login).toContain("await doBiometricUnlock(true)");
    expect(login).toContain('biometricLabel');
    expect(login).toContain('@animationstart="handleUnlockAutofill"');
    expect(login).toContain("hainei-password-autofill");
    expect(login).toContain("void doUnlock()");
    expect(login).toContain("使用本地密码");
    expect(login).not.toContain("Face ID");
  });

  it("lets an unlocked encrypted account enable or disable passkey login in settings", () => {
    const settings = readFileSync(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");
    expect(settings).toContain("通行密钥");
    expect(settings).toContain("toggleBiometricUnlock");
    expect(settings).toContain("await keyStore.enableBiometricUnlock()");
    expect(settings).toContain("await keyStore.disableBiometricUnlock()");
  });
});
