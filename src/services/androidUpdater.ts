export type AndroidUpdateManifest = {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  sha256: string;
  notes: string;
  publishedAt: string;
  commit: string;
};

type NativeVersion = {
  versionCode: number;
  versionName: string;
};

type NativeUpdaterPlugin = {
  getCurrentVersion: () => Promise<NativeVersion>;
  installApk: (options: { url: string; sha256: string }) => Promise<void>;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: Record<string, unknown>;
};

const RELEASE_BASE = "https://github.com/ganlinlaomu/HaiNei/releases/download/android-latest/";
const MANIFEST_URL = `${RELEASE_BASE}update.json`;
const RELEASE_API_URL = "https://api.github.com/repos/ganlinlaomu/HaiNei/releases/tags/android-latest";
const LAST_CHECK_KEY = "hainei_android_update_last_check";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let cachedAvailableUpdate: AndroidUpdateManifest | null = null;
const listeners = new Set<(update: AndroidUpdateManifest) => void>();

function capacitor(): CapacitorGlobal | undefined {
  return (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
}

function nativeUpdater(): NativeUpdaterPlugin | null {
  const cap = capacitor();
  const plugin = cap?.Plugins?.HaiNeiUpdater as NativeUpdaterPlugin | undefined;
  return plugin || null;
}

export function isNativeAndroidApp(): boolean {
  const cap = capacitor();
  return cap?.isNativePlatform?.() === true && cap?.getPlatform?.() === "android";
}

function validManifest(value: unknown): value is AndroidUpdateManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<AndroidUpdateManifest>;
  return Number.isInteger(manifest.versionCode)
    && Number(manifest.versionCode) > 0
    && typeof manifest.versionName === "string"
    && !!manifest.versionName
    && typeof manifest.apkUrl === "string"
    && manifest.apkUrl.startsWith(RELEASE_BASE)
    && typeof manifest.sha256 === "string"
    && /^[a-f0-9]{64}$/i.test(manifest.sha256)
    && typeof manifest.notes === "string"
    && typeof manifest.publishedAt === "string"
    && typeof manifest.commit === "string";
}

async function fetchManifestFromUrl(url: string) {
  const response = await fetch(url, { cache: "no-store", redirect: "follow" });
  if (!response.ok) throw new Error(`更新信息请求失败（${response.status}）`);
  const manifest: unknown = await response.json();
  if (!validManifest(manifest)) throw new Error("更新信息格式无效");
  return manifest;
}

async function fetchManifest(): Promise<AndroidUpdateManifest> {
  try {
    return await fetchManifestFromUrl(MANIFEST_URL);
  } catch (directError) {
    const releaseResponse = await fetch(RELEASE_API_URL, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!releaseResponse.ok) throw directError;
    const release = await releaseResponse.json() as {
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    const asset = release.assets?.find(item => item.name === "update.json");
    if (!asset?.browser_download_url) throw directError;
    return fetchManifestFromUrl(asset.browser_download_url);
  }
}

export async function getCurrentAndroidVersion(): Promise<NativeVersion | null> {
  if (!isNativeAndroidApp()) return null;
  const plugin = nativeUpdater();
  if (!plugin) throw new Error("Android 更新组件不可用，请安装最新 APK");
  const current = await plugin.getCurrentVersion();
  return {
    versionCode: Number(current.versionCode) || 0,
    versionName: String(current.versionName || ""),
  };
}

function shouldThrottleCheck(force: boolean) {
  if (force) return false;
  try {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) || "0");
    return last > 0 && Date.now() - last < CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}

function markChecked() {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    // Update checks must still work when storage is unavailable.
  }
}

function announce(update: AndroidUpdateManifest) {
  cachedAvailableUpdate = update;
  for (const listener of listeners) listener(update);
}

export function onAndroidUpdateAvailable(listener: (update: AndroidUpdateManifest) => void) {
  listeners.add(listener);
  if (cachedAvailableUpdate) listener(cachedAvailableUpdate);
  return () => listeners.delete(listener);
}

export async function checkAndroidUpdate(force = false): Promise<AndroidUpdateManifest | null> {
  if (!isNativeAndroidApp()) return null;
  if (shouldThrottleCheck(force)) return cachedAvailableUpdate;

  const [current, manifest] = await Promise.all([
    getCurrentAndroidVersion(),
    fetchManifest(),
  ]);
  markChecked();
  if (!current || manifest.versionCode <= current.versionCode) {
    cachedAvailableUpdate = null;
    return null;
  }

  announce(manifest);
  return manifest;
}

export async function installAndroidUpdate(update: AndroidUpdateManifest): Promise<void> {
  if (!isNativeAndroidApp()) throw new Error("仅 Android APK 支持应用内更新");
  if (!validManifest(update)) throw new Error("更新信息无效");
  const plugin = nativeUpdater();
  if (!plugin) throw new Error("Android 更新组件不可用，请安装最新 APK");
  await plugin.installApk({ url: update.apkUrl, sha256: update.sha256 });
}
