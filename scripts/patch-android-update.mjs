#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const androidRoot = path.join(root, "android");
const appRoot = path.join(androidRoot, "app");
const packageDir = path.join(appRoot, "src", "main", "java", "cafe", "aso", "hainei");
const manifestPath = path.join(appRoot, "src", "main", "AndroidManifest.xml");
const gradlePath = path.join(appRoot, "build.gradle");
const filePathsPath = path.join(appRoot, "src", "main", "res", "xml", "hainei_update_paths.xml");
const mainActivityPath = path.join(packageDir, "MainActivity.java");
const pluginPath = path.join(packageDir, "HaiNeiUpdaterPlugin.java");

if (!fs.existsSync(androidRoot)) {
  throw new Error("android project missing; run cap add android first");
}

const versionCode = Number(process.env.HAINEI_VERSION_CODE || "1");
const versionName = process.env.HAINEI_VERSION_NAME || "0.0.0";
const releaseSigning = process.env.HAINEI_ENABLE_RELEASE_SIGNING === "1";

if (!Number.isInteger(versionCode) || versionCode <= 0) {
  throw new Error("HAINEI_VERSION_CODE must be a positive integer");
}

if (releaseSigning) {
  for (const name of [
    "HAINEI_KEYSTORE_FILE",
    "HAINEI_KEYSTORE_PASSWORD",
    "HAINEI_KEY_ALIAS",
    "HAINEI_KEY_PASSWORD",
  ]) {
    if (!process.env[name]) throw new Error(`${name} is required for release signing`);
  }
}

fs.mkdirSync(packageDir, { recursive: true });
fs.mkdirSync(path.dirname(filePathsPath), { recursive: true });

fs.writeFileSync(mainActivityPath, `package cafe.aso.hainei;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HaiNeiUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);

fs.writeFileSync(pluginPath, `package cafe.aso.hainei;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "HaiNeiUpdater")
public class HaiNeiUpdaterPlugin extends Plugin {
    private static final String RELEASE_PREFIX =
        "https://github.com/ganlinlaomu/HaiNei/releases/download/android-latest/";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void getCurrentVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;

            JSObject result = new JSObject();
            result.put("versionCode", versionCode);
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法读取当前版本", "VERSION_READ_FAILED", error);
        }
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String url = call.getString("url", "");
        String expectedSha256 = call.getString("sha256", "").toLowerCase(Locale.ROOT);

        if (!url.startsWith(RELEASE_PREFIX)) {
            call.reject("拒绝非官方更新地址", "INVALID_UPDATE_URL");
            return;
        }
        if (!expectedSha256.matches("^[a-f0-9]{64}$")) {
            call.reject("更新校验值无效", "INVALID_UPDATE_HASH");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent permissionIntent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            permissionIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(permissionIntent);
            call.reject("请允许海内安装未知来源应用", "INSTALL_PERMISSION_REQUIRED");
            return;
        }

        executor.execute(() -> {
            File updateDir = new File(getContext().getCacheDir(), "updates");
            File apkFile = new File(updateDir, "HaiNei-update.apk");
            HttpURLConnection connection = null;
            try {
                if (!updateDir.exists() && !updateDir.mkdirs()) {
                    throw new IllegalStateException("无法创建更新目录");
                }

                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(60000);
                connection.setRequestProperty("User-Agent", "HaiNei-Android-Updater");
                connection.connect();

                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    throw new IllegalStateException("更新下载失败（HTTP " + status + "）");
                }

                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (
                    InputStream raw = new BufferedInputStream(connection.getInputStream());
                    FileOutputStream output = new FileOutputStream(apkFile)
                ) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = raw.read(buffer)) != -1) {
                        output.write(buffer, 0, count);
                        digest.update(buffer, 0, count);
                    }
                    output.flush();
                }

                String actualSha256 = toHex(digest.digest());
                if (!actualSha256.equalsIgnoreCase(expectedSha256)) {
                    apkFile.delete();
                    throw new SecurityException("更新包 SHA-256 校验失败");
                }

                getActivity().runOnUiThread(() -> {
                    try {
                        Uri apkUri = FileProvider.getUriForFile(
                            getContext(),
                            getContext().getPackageName() + ".fileprovider",
                            apkFile
                        );
                        Intent installIntent = new Intent(Intent.ACTION_VIEW);
                        installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                        installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        getActivity().startActivity(installIntent);
                        call.resolve();
                    } catch (Exception error) {
                        call.reject("无法打开 Android 安装界面", "INSTALL_INTENT_FAILED", error);
                    }
                });
            } catch (Exception error) {
                if (apkFile.exists()) apkFile.delete();
                call.reject(error.getMessage() == null ? "更新下载失败" : error.getMessage(), "UPDATE_DOWNLOAD_FAILED", error);
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private static String toHex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) builder.append(String.format(Locale.ROOT, "%02x", value));
        return builder.toString();
    }
}
`);

fs.writeFileSync(filePathsPath, `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="updates" path="updates/" />
</paths>
`);

let manifest = fs.readFileSync(manifestPath, "utf8");
if (!manifest.includes("android.permission.REQUEST_INSTALL_PACKAGES")) {
  manifest = manifest.replace(
    "<application",
    '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n\n    <application'
  );
}
if (!manifest.includes(".fileprovider")) {
  manifest = manifest.replace(
    "</application>",
    `        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/hainei_update_paths" />
        </provider>
    </application>`
  );
}
fs.writeFileSync(manifestPath, manifest);

let gradle = fs.readFileSync(gradlePath, "utf8");
gradle = gradle
  .replace(/versionCode\s*=*\s*\d+/, `versionCode = ${versionCode}`)
  .replace(/versionName\s*=*\s*["'][^"']*["']/, `versionName = "${versionName}"`);

if (releaseSigning && !gradle.includes("HAINEI_RELEASE_SIGNING")) {
  const signingBlock = `
    // HAINEI_RELEASE_SIGNING
    signingConfigs {
        release {
            storeFile = file(System.getenv("HAINEI_KEYSTORE_FILE"))
            storePassword = System.getenv("HAINEI_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("HAINEI_KEY_ALIAS")
            keyPassword = System.getenv("HAINEI_KEY_PASSWORD")
        }
    }
`;
  gradle = gradle.replace(/\n\s*buildTypes\s*\{/, `${signingBlock}\n    buildTypes {`);
  gradle = gradle.replace(
    /(buildTypes\s*\{\s*release\s*\{)/,
    '$1\n            signingConfig = signingConfigs.release'
  );
}

fs.writeFileSync(gradlePath, gradle);
console.log(`Android updater patched: versionCode=${versionCode} versionName=${versionName} releaseSigning=${releaseSigning}`);
