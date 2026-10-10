import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { deviceStorage } from "@/services/deviceStorage";
import { isNativeAndroidApp } from "@/services/androidUpdater";
import { postPushAuthorized } from "@/services/pushNotifications";

type SignEvent = (event: EventTemplate) => Promise<VerifiedEvent>;
type ListenerHandle = { remove: () => Promise<void> };
type NativePlugin = {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  createChannel(options: { id: string; name: string; description: string; importance: number; visibility: number }): Promise<void>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  addListener(event: string, listener: (payload: any) => void): Promise<ListenerHandle>;
};
type NativeCapacitor = {
  Plugins?: Record<string, unknown>;
  registerPlugin?: (name: string) => unknown;
};

const TOKEN_KEY = "hainei_native_push_token";
const CHANNEL = "hainei_messages";
const REGISTER_TIMEOUT_MS = 20000;
let pluginInstance: NativePlugin | null = null;
let initialized = false;
let pendingToken: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null;
let currentAccount: { pubkey: string; signEvent: SignEvent; accepted: string[] } | null = null;
let publishing = Promise.resolve();

function nativePlugin(): NativePlugin | null {
  if (!isNativeAndroidApp()) return null;
  const bridge = (window as Window & { Capacitor?: NativeCapacitor }).Capacitor;
  if (!bridge) return null;
  if (pluginInstance) return pluginInstance;
  const plugin = bridge.Plugins?.PushNotifications ?? bridge.registerPlugin?.("PushNotifications");
  if (!plugin || typeof (plugin as NativePlugin).register !== "function") return null;
  pluginInstance = plugin as NativePlugin;
  return pluginInstance;
}

export function nativePushAvailable() { return !!nativePlugin(); }
export function nativePushEnabled(pubkey: string) {
  return !!pubkey && deviceStorage.getItem(`hainei_native_push_enabled_${pubkey.toLowerCase()}`) === "1";
}

async function initialize(plugin: NativePlugin) {
  if (initialized) return;
  // Registration listener must be installed before invoking register().
  await plugin.addListener("registration", value => {
    const token = String(value?.value || "");
    if (pendingToken) pendingToken.resolve(token);
    else if (currentAccount) {
      const { pubkey, signEvent, accepted } = currentAccount;
      void publishToken(pubkey, token, accepted, signEvent).catch(() => {});
    }
  });
  await plugin.addListener("registrationError", error => {
    pendingToken?.reject(new Error(String(error?.error || "FCM 注册失败")));
  });
  await plugin.addListener("pushNotificationActionPerformed", notification => {
    if (notification?.notification?.data?.type === "message") window.location.hash = "#/conversations";
  });
  initialized = true;
}

async function publishToken(pubkey: string, rawToken: string, accepted: string[], signEvent: SignEvent) {
  const token = rawToken.trim();
  if (!token || !currentAccount || currentAccount.pubkey !== pubkey) return;
  // Serialize rotations: a slow old-token response must never overwrite the new one.
  const publish = async () => {
    if (!currentAccount || currentAccount.pubkey !== pubkey) return;
    const old = deviceStorage.getItem(TOKEN_KEY);
    await postPushAuthorized("/api/push/native/subscribe", { token }, pubkey, signEvent);
    if (!currentAccount || currentAccount.pubkey !== pubkey) return;
    await postPushAuthorized("/api/push/policy", { senderPubkeys: [...new Set(accepted)] }, pubkey, signEvent);
    if (old && old !== token) {
      await postPushAuthorized("/api/push/native/unsubscribe", { token: old }, pubkey, signEvent).catch(() => {});
    }
    deviceStorage.setItem(TOKEN_KEY, token);
  };
  publishing = publishing.catch(() => {}).then(publish);
  await publishing;
}

async function registerForAccount(pubkey: string, signEvent: SignEvent, accepted: string[], requestPermission: boolean) {
  const plugin = nativePlugin();
  if (!plugin) throw new Error("APK 尚未配置 Firebase 原生推送，请安装启用 FCM 的新版本");
  await initialize(plugin);
  let permission = await plugin.checkPermissions();
  if (permission.receive !== "granted" && requestPermission) permission = await plugin.requestPermissions();
  if (permission.receive !== "granted") throw new Error("请在 Android 系统设置中允许海内通知");
  currentAccount = { pubkey, signEvent, accepted };
  await plugin.createChannel({ id: CHANNEL, name: "私信通知", description: "新私信隐私提醒", importance: 4, visibility: 0 });
  if (pendingToken) throw new Error("正在注册 FCM，请稍后重试");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tokenPromise = new Promise<string>((resolve, reject) => {
      pendingToken = { resolve, reject };
      timer = setTimeout(() => reject(new Error("FCM 注册超时，请检查 Google Play 服务")), REGISTER_TIMEOUT_MS);
    });
    await plugin.register();
    const token = await tokenPromise;
    await publishToken(pubkey, token, accepted, signEvent);
  } finally {
    clearTimeout(timer);
    pendingToken = null;
  }
}

export async function enableAndroidNativePush(pubkey: string, signEvent: SignEvent, accepted: string[]) {
  await registerForAccount(pubkey, signEvent, accepted, true);
  deviceStorage.setItem(`hainei_native_push_enabled_${pubkey.toLowerCase()}`, "1");
}

export async function resumeAndroidNativePush(pubkey: string, signEvent: SignEvent, accepted: string[]) {
  if (!nativePushEnabled(pubkey) || !nativePlugin()) return false;
  await registerForAccount(pubkey, signEvent, accepted, false);
  return true;
}

export async function detachAndroidNativePush(pubkey: string, signEvent: SignEvent, disable = false) {
  if (!isNativeAndroidApp()) return;
  currentAccount = null;
  const token = deviceStorage.getItem(TOKEN_KEY);
  const plugin = nativePlugin();
  try {
    if (token) await postPushAuthorized("/api/push/native/unsubscribe", { token }, pubkey, signEvent);
  } finally {
    // Even without network, an invalidated FCM registration cannot receive old-account pushes.
    await plugin?.unregister().catch(() => {});
    deviceStorage.removeItem(TOKEN_KEY);
    if (disable) deviceStorage.removeItem(`hainei_native_push_enabled_${pubkey.toLowerCase()}`);
  }
}

export async function testAndroidNativePush(pubkey: string, signEvent: SignEvent) {
  const token = deviceStorage.getItem(TOKEN_KEY);
  if (!token) throw new Error("没有本机 FCM Token，请重新开启推送");
  const result = await postPushAuthorized("/api/push/native/test", { token }, pubkey, signEvent);
  if (!result?.subscriptionsFound) throw new Error("服务器未找到本机 Android 推送订阅");
  if (result.expired) throw new Error("FCM Token 已过期，请重新开启推送");
  if (!result.sent) throw new Error("FCM 发送失败，请检查 Worker 日志和 Firebase 配置");
  return "FCM 已接受测试通知；请检查 Android 通知栏。此结果不代表通知已显示。";
}
