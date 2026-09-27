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

  it("builds an installable debug APK entirely in GitHub Actions", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/android.yml"), "utf8");
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain('java-version: "21"');
    expect(workflow).toContain("@capacitor/core@8");
    expect(workflow).toContain("@capacitor/android@8");
    expect(workflow).toContain('"platform-tools" "platforms;android-36" "build-tools;36.0.0"');
    expect(workflow).toContain("./.capacitor-ci/node_modules/.bin/cap add android");
    expect(workflow).toContain("./gradlew assembleDebug --no-daemon");
    expect(workflow).toContain("HaiNei-debug.apk");
    expect(workflow).toContain("actions/upload-artifact@v4");
  });

  it("injects the HaiNei Worker URL into Android builds and refuses broken APKs", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/android.yml"), "utf8");
    expect(workflow).toContain("VITE_HAINEI_WORKER_URL: ${{ vars.VITE_HAINEI_WORKER_URL }}");
    expect(workflow).toContain("Verify HaiNei Worker URL");
    expect(workflow).toContain('if [ -z "$VITE_HAINEI_WORKER_URL" ]');
    expect(workflow).toContain("VITE_HAINEI_WORKER_URL must use https://");
  });

  it("does not run the PWA service worker inside the native Capacitor container", () => {
    const source = readFileSync(join(process.cwd(), "src/main.ts"), "utf8");
    expect(source).toContain("function isNativeContainer()");
    expect(source).toContain("if (isNativeContainer()) return;");
  });
});
