import type { RecoveryProviderSession } from "@/services/recovery/types";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GoogleTokenClient = {
  requestAccessToken(config?: { prompt?: string }): void;
};

type GoogleOAuth2 = {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    include_granted_scopes?: boolean;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): GoogleTokenClient;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: GoogleOAuth2;
      };
    };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing || document.createElement("script");
    let timeout = 0;

    const cleanup = () => {
      if (timeout) window.clearTimeout(timeout);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };
    const onLoad = () => {
      cleanup();
      if (window.google?.accounts?.oauth2) resolve();
      else reject(new Error("Google 登录组件加载失败"));
    };
    const onError = () => {
      cleanup();
      scriptPromise = null;
      reject(new Error("无法加载 Google 登录组件"));
    };

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    timeout = window.setTimeout(() => onError(), 15_000);

    if (!existing) {
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return scriptPromise;
}

export function preloadGoogleIdentityServices() {
  return loadGoogleIdentityServices();
}

function hasRequiredScopes(scope: string | undefined) {
  const scopes = new Set((scope || "").split(/\s+/).filter(Boolean));
  return scopes.has(DRIVE_APPDATA_SCOPE);
}

async function fetchGoogleSubject(accessToken: string) {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("无法确认 Google 账号身份");
  const body = await response.json() as { sub?: string };
  if (!body.sub) throw new Error("Google 未返回稳定账号标识");
  return body.sub;
}

export async function signInWithGoogle(clientId: string): Promise<RecoveryProviderSession> {
  const normalizedClientId = clientId.trim();
  if (!normalizedClientId) throw new Error("Google 登录尚未配置");
  if (!window.google?.accounts?.oauth2) await loadGoogleIdentityServices();

  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error("Google 登录组件不可用");

  const token = await new Promise<GoogleTokenResponse>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: normalizedClientId,
      scope: `openid ${DRIVE_APPDATA_SCOPE}`,
      include_granted_scopes: true,
      callback: response => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || "Google 授权失败"));
          return;
        }
        resolve(response);
      },
      error_callback: error => {
        const type = error?.type || "";
        if (type === "popup_closed") reject(new DOMException("Google 登录已取消", "AbortError"));
        else reject(new Error(error?.message || "Google 登录窗口打开失败"));
      },
    });
    client.requestAccessToken({ prompt: "select_account" });
  });

  if (!token.access_token || !hasRequiredScopes(token.scope)) {
    throw new Error("未获得 Google Drive 应用数据权限");
  }

  const subject = await fetchGoogleSubject(token.access_token);
  return {
    provider: "google",
    subject,
    accessToken: token.access_token,
    expiresAt: Date.now() + Math.max(0, Number(token.expires_in || 0) - 30) * 1000,
  };
}

export const googleRecoveryScopes = Object.freeze({
  openid: "openid",
  driveAppData: DRIVE_APPDATA_SCOPE,
});
