import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDriveBackupService } from "@/services/recovery/googleDriveBackup";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Google recovery foundation", () => {
  it("keeps Google as a recovery provider instead of a new signer login method", () => {
    const login = source("src/views/Login.vue");
    const keys = source("src/stores/keys.ts");
    const panel = source("src/components/GoogleRecoveryPanel.vue");

    expect(login).toContain("<GoogleRecoveryPanel");
    expect(panel).toContain("<span>使用Google登录</span>");
    expect(panel).toContain('<h2 id="google-recovery-title">使用Google登录</h2>');
    expect(panel).not.toContain("使用 Google 继续");
    expect(login).toContain("VITE_GOOGLE_WEB_CLIENT_ID");
    expect(login).toContain("await ks.loginWithNsec(payload.skHex)");
    expect(panel).toContain('beginRecovery("google"');
    expect(panel).toContain("Capacitor?.isNativePlatform");
    expect(keys).not.toContain('loginMethod: "google"');
  });

  it("requests only OpenID identity plus Drive appData and never persists the token", () => {
    const auth = source("src/services/recovery/googleAuth.ts");

    expect(auth).toContain("openid");
    expect(auth).toContain("https://www.googleapis.com/auth/drive.appdata");
    expect(auth).toContain("https://openidconnect.googleapis.com/v1/userinfo");
    expect(auth).not.toContain("localStorage");
    expect(auth).not.toContain("sessionStorage");
    expect(auth).not.toContain("indexedDB");
  });

  it("lists only opaque HaiNei appData backups", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      files: [
        { id: "a", name: "hainei_bk_opaque.bin", modifiedTime: "2026-10-02T00:00:00Z" },
        { id: "b", name: "not-hainei.txt", modifiedTime: "2026-10-03T00:00:00Z" },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new GoogleDriveBackupService({
      provider: "google",
      subject: "sub",
      accessToken: "token",
    });
    await expect(service.listBackups()).resolves.toEqual([
      { id: "a", name: "hainei_bk_opaque.bin", modifiedTime: "2026-10-02T00:00:00Z" },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("spaces=appDataFolder");
    expect(url).toContain("hainei_bk_");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token");
  });

  it("downloads a backup through Drive media API without exposing the access token in the URL", async () => {
    const fetchMock = vi.fn(async () => new Response("encrypted-payload", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new GoogleDriveBackupService({
      provider: "google",
      subject: "sub",
      accessToken: "secret-access-token",
    });
    await expect(service.downloadBackup("file-id")).resolves.toBe("encrypted-payload");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/files/file-id?alt=media");
    expect(url).not.toContain("secret-access-token");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret-access-token");
  });

  it("allows Google Identity Services through the Pages CSP", () => {
    const headers = source("public/_headers");
    expect(headers).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(headers).toContain("https://accounts.google.com/gsi/style");
  });

  it("removes a failed GIS script so the same page can retry", () => {
    const auth = source("src/services/recovery/googleAuth.ts");
    expect(auth).toContain("script.remove()");
    expect(auth).toContain("scriptPromise = null");
  });

  it("types the optional Google web client ID", () => {
    expect(source("src/env.d.ts")).toContain("VITE_GOOGLE_WEB_CLIENT_ID?: string");
  });
});
