import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Android Capacitor build", () => {
  it("keeps the native shell configuration minimal and points at Vite output", () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), "capacitor.config.json"), "utf8"));
    expect(config).toMatchObject({
      appId: "cafe.aso.hainei",
      appName: "海内",
      webDir: "dist",
      android: { allowMixedContent: false },
    });
  });

  it("builds Android in GitHub Actions and patches the native updater", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/android.yml"), "utf8");
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain('java-version: "21"');
    expect(workflow).toContain("@capacitor/core@8");
    expect(workflow).toContain("@capacitor/android@8");
    expect(workflow).toContain('"platform-tools" "platforms;android-36" "build-tools;36.0.0"');
    expect(workflow).toContain("./.capacitor-ci/node_modules/.bin/cap add android");
    expect(workflow).toContain("@capacitor/push-notifications@8");
    expect(workflow).toContain("HAINEI_FIREBASE_CONFIG_BASE64");
    expect(workflow).toContain("android/app/google-services.json");
    expect(workflow).toContain("cafe.aso.hainei");
    expect(workflow).toContain("node scripts/patch-android-update.mjs");
    expect(workflow).toContain("./gradlew assembleDebug --no-daemon");
    expect(workflow).toContain("./gradlew assembleRelease --no-daemon");
    expect(workflow).toContain("actions/upload-artifact@v4");
  });

  it("publishes only signed main builds as the rolling update release", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/android.yml"), "utf8");
    expect(workflow).toContain("HAINEI_ANDROID_KEYSTORE_BASE64");
    expect(workflow).toContain("HAINEI_ANDROID_KEYSTORE_PASSWORD");
    expect(workflow).toContain("HAINEI_ANDROID_KEY_ALIAS");
    expect(workflow).toContain("HAINEI_ANDROID_KEY_PASSWORD");
    expect(workflow).toContain("HAINEI_SIGNING_READY");
    expect(workflow).toContain("artifacts/HaiNei.apk");
    expect(workflow).toContain("artifacts/update.json");
    expect(workflow).toContain("android-latest");
    expect(workflow).toContain("generate-android-update-manifest.mjs");
  });

  it("injects the HaiNei Worker URL into Android builds and refuses broken APKs", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/android.yml"), "utf8");
    expect(workflow).toContain("VITE_HAINEI_WORKER_URL: https://hainei-media.noster.workers.dev");
    expect(workflow).toContain('VITE_ENABLE_NIP46: "true"');
    expect(workflow).toContain("Verify HaiNei Worker URL");
    expect(workflow).toContain('if [ -z "$VITE_HAINEI_WORKER_URL" ]');
    expect(workflow).toContain("VITE_HAINEI_WORKER_URL must use https://");
  });

  it("does not run the PWA service worker inside the native Capacitor container", () => {
    const source = readFileSync(join(process.cwd(), "src/main.ts"), "utf8");
    expect(source).toContain("function isNativeContainer()");
    expect(source).toContain("if (isNativeContainer()) return;");
  });

  it("mounts Android update UI without replacing the existing PWA updater", () => {
    const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
    const settings = readFileSync(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");
    expect(app).toContain("<UpdateNotification />");
    expect(app).toContain("<AndroidUpdateNotification />");
    expect(settings).toContain("应用更新 / Update");
    expect(settings).toContain("checkAndroidUpdate(true)");
  });
});
