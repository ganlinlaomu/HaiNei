import { deviceStorage, putDeviceValue } from "@/services/deviceStorage";

const ACCOUNT_REGISTRY_KEY = "hainei_device_accounts";

export type AccountAuthType = "private-key" | "nip46";
export type AccountCredentialMode = "device" | "password" | "passkey" | "session";

export interface DeviceAccount {
  pubkey: string;
  authType: AccountAuthType;
  hasEncryptedKey: boolean;
  credentialMode: AccountCredentialMode;
  lastUsedAt: number;
  /** Local-only label so the account picker can greet people by name before unlock. */
  displayName?: string;
  /** Small data: URL thumbnail of the account's own avatar, never uploaded. */
  avatarThumb?: string;
}

export type DeviceAccountPresentation = Pick<DeviceAccount, "displayName" | "avatarThumb">;

const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_AVATAR_THUMB_LENGTH = 24_000;

function cleanPresentation(value: Partial<DeviceAccountPresentation>): DeviceAccountPresentation {
  const clean: DeviceAccountPresentation = {};
  const name = typeof value.displayName === "string" ? value.displayName.trim().slice(0, MAX_DISPLAY_NAME_LENGTH) : "";
  if (name) clean.displayName = name;
  const thumb = typeof value.avatarThumb === "string" ? value.avatarThumb : "";
  if (/^data:image\/(?:jpeg|png|webp);base64,/.test(thumb) && thumb.length <= MAX_AVATAR_THUMB_LENGTH) clean.avatarThumb = thumb;
  return clean;
}

function validCredentialMode(value: unknown): value is AccountCredentialMode {
  return value === "device" || value === "password" || value === "passkey" || value === "session";
}

function validAccount(value: unknown): value is DeviceAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<DeviceAccount>;
  return typeof account.pubkey === "string"
    && /^[0-9a-f]{64}$/i.test(account.pubkey)
    && (account.authType === "private-key" || account.authType === "nip46")
    && typeof account.hasEncryptedKey === "boolean"
    && Number.isFinite(account.lastUsedAt);
}

export function listDeviceAccounts(): DeviceAccount[] {
  try {
    const parsed = JSON.parse(deviceStorage.getItem(ACCOUNT_REGISTRY_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(validAccount)
      .map(account => ({
        ...account,
        ...cleanPresentation(account),
        pubkey: account.pubkey.toLowerCase(),
        credentialMode: validCredentialMode(account.credentialMode)
          ? account.credentialMode
          : account.hasEncryptedKey ? "password" : "session",
      }))
      .filter(account => account.credentialMode !== "session")
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch {
    return [];
  }
}

export async function rememberDeviceAccount(account: DeviceAccount): Promise<DeviceAccount[]> {
  const pubkey = account.pubkey.toLowerCase();
  const existing = listDeviceAccounts().find(item => item.pubkey === pubkey);
  // Logins only know credentials; keep the name/avatar learned from the profile.
  const normalized: DeviceAccount = {
    ...account,
    ...cleanPresentation({ ...existing, ...account }),
    pubkey,
  };
  const accounts = listDeviceAccounts().filter(item => item.pubkey !== pubkey);
  accounts.push(normalized);
  accounts.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  await putDeviceValue(ACCOUNT_REGISTRY_KEY, JSON.stringify(accounts));
  return accounts;
}

export async function forgetDeviceAccount(pubkey: string): Promise<DeviceAccount[]> {
  const normalized = pubkey.toLowerCase();
  const accounts = listDeviceAccounts().filter(account => account.pubkey !== normalized);
  await putDeviceValue(ACCOUNT_REGISTRY_KEY, JSON.stringify(accounts));
  return accounts;
}

export async function updateDeviceAccountPresentation(
  pubkey: string,
  presentation: Partial<DeviceAccountPresentation>,
): Promise<DeviceAccount[]> {
  const normalized = pubkey.toLowerCase();
  const accounts = listDeviceAccounts();
  const index = accounts.findIndex(account => account.pubkey === normalized);
  // Session-only logins are not remembered, so they never gain a stored name.
  if (index < 0) return accounts;
  const current = accounts[index];
  const next: DeviceAccount = {
    pubkey: current.pubkey,
    authType: current.authType,
    hasEncryptedKey: current.hasEncryptedKey,
    credentialMode: current.credentialMode,
    lastUsedAt: current.lastUsedAt,
    ...cleanPresentation({ ...current, ...presentation }),
  };
  if (next.displayName === current.displayName && next.avatarThumb === current.avatarThumb) return accounts;
  accounts[index] = next;
  await putDeviceValue(ACCOUNT_REGISTRY_KEY, JSON.stringify(accounts));
  return accounts;
}

export function accountDisplayName(account: Pick<DeviceAccount, "displayName">) {
  return account.displayName || "未命名账号";
}

export function accountInitial(account: Pick<DeviceAccount, "displayName">) {
  return (account.displayName?.trim()[0] || "海").toUpperCase();
}

export function accountColor(pubkey: string) {
  let hash = 0;
  for (const char of pubkey) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 38% 46%)`;
}

export function formatLastUsed(timestamp: number, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "很久以前";
  const startOfDay = (value: number) => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
    : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
