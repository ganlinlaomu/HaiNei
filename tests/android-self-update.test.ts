import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function makeAndroidFixture() {
  const root = mkdtempSync(join(tmpdir(), "hainei-android-update-"));
  tempRoots.push(root);
  const app = join(root, "android", "app");
  mkdirSync(join(app, "src", "main", "java", "cafe", "aso", "hainei"), { recursive: true });
  mkdirSync(join(app, "src", "main", "res"), { recursive: true });
  writeFileSync(
    join(app, "src", "main", "AndroidManifest.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="海内"></application>
</manifest>
`
  );
  writeFileSync(
    join(app, "build.gradle"),
    `android {
  defaultConfig {
    applicationId = "cafe.aso.hainei"
    versionCode = 1
    versionName = "1.0"
  }

  buildTypes {
    release {
      minifyEnabled = false
    }
  }
}
`
  );
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Android self update", () => {
  it("patches a generated Capacitor project with the updater bridge and version metadata", () => {
    const root = makeAndroidFixture();
    const script = join(process.cwd(), "scripts", "patch-android-update.mjs");
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HAINEI_VERSION_CODE: "100123",
        HAINEI_VERSION_NAME: "0.1.5+123",
        HAINEI_ENABLE_RELEASE_SIGNING: "0",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);

    const manifest = readFileSync(join(root, "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
    const gradle = readFileSync(join(root, "android", "app", "build.gradle"), "utf8");
    const activity = readFileSync(
      join(root, "android", "app", "src", "main", "java", "cafe", "aso", "hainei", "MainActivity.java"),
      "utf8"
    );
    const plugin = readFileSync(
      join(root, "android", "app", "src", "main", "java", "cafe", "aso", "hainei", "HaiNeiUpdaterPlugin.java"),
      "utf8"
    );
    const paths = readFileSync(
      join(root, "android", "app", "src", "main", "res", "xml", "hainei_update_paths.xml"),
      "utf8"
    );

    expect(manifest).toContain("android.permission.REQUEST_INSTALL_PACKAGES");
    expect(manifest).toContain('android:authorities="cafe.aso.hainei.fileprovider"');
    expect(activity).toContain("registerPlugin(HaiNeiUpdaterPlugin.class)");
    expect(plugin).toContain('@CapacitorPlugin(name = "HaiNeiUpdater")');
    expect(plugin).toContain("SHA-256");
    expect(plugin).toContain("canRequestPackageInstalls()");
    expect(paths).toContain('<cache-path name="updates" path="updates/" />');
    expect(gradle).toContain("versionCode = 100123");
    expect(gradle).toContain('versionName = "0.1.5+123"');
  });

  it("adds release signing only when explicitly enabled", () => {
    const root = makeAndroidFixture();
    const script = join(process.cwd(), "scripts", "patch-android-update.mjs");
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HAINEI_VERSION_CODE: "100124",
        HAINEI_VERSION_NAME: "0.1.5+124",
        HAINEI_ENABLE_RELEASE_SIGNING: "1",
        HAINEI_KEYSTORE_FILE: "/tmp/hainei-release.jks",
        HAINEI_KEYSTORE_PASSWORD: "store-pass",
        HAINEI_KEY_ALIAS: "hainei",
        HAINEI_KEY_PASSWORD: "key-pass",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const gradle = readFileSync(join(root, "android", "app", "build.gradle"), "utf8");
    expect(gradle).toContain("HAINEI_RELEASE_SIGNING");
    expect(gradle).toContain('System.getenv("HAINEI_KEYSTORE_FILE")');
    expect(gradle).toContain("signingConfig = signingConfigs.release");
  });

  it("generates a strict rolling update manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "hainei-update-manifest-"));
    tempRoots.push(root);
    const output = join(root, "update.json");
    const script = join(process.cwd(), "scripts", "generate-android-update-manifest.mjs");
    const sha = "a".repeat(64);
    const result = spawnSync(
      process.execPath,
      [script, output, "100125", "0.1.5+125", sha, "abc123", "quoted replies and updater"],
      { encoding: "utf8" }
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    expect(manifest).toMatchObject({
      versionCode: 100125,
      versionName: "0.1.5+125",
      apkUrl: "https://github.com/ganlinlaomu/HaiNei/releases/download/android-latest/HaiNei.apk",
      sha256: sha,
      commit: "abc123",
      notes: "quoted replies and updater",
    });
  });

  it("keeps update discovery restricted to the HaiNei rolling release", () => {
    const service = readFileSync(join(process.cwd(), "src", "services", "androidUpdater.ts"), "utf8");
    expect(service).toContain("releases/download/android-latest/");
    expect(service).toContain("manifest.versionCode <= current.versionCode");
    expect(service).toContain('/^[a-f0-9]{64}$/i');
    expect(service).toContain("plugin.installApk({ url: update.apkUrl, sha256: update.sha256 })");
  });
});
