import { deviceStorage } from "@/services/deviceStorage";

const ACCOUNT_REGISTRY_KEY = "hainei_device_accounts";

export type AccountAuthType = "google" | "private-key";

export interface DeviceAccount {
  pubkey: string;
  authType: AccountAuthType;
  hasEncryptedKey: boolean;
  lastUsedAt: number;
}

function validAccount(value: unknown): value is DeviceAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<DeviceAccount>;
  return typeof account.pubkey === "string"
    && /^[0-9a-f]{64}$/i.test(account.pubkey)
    && (account.authType === "google" || account.authType === "private-key")
    && typeof account.hasEncryptedKey === "boolean"
    && Number.isFinite(account.lastUsedAt);
}

export function listDeviceAccounts(): DeviceAccount[] {
  try {
    const parsed = JSON.parse(deviceStorage.getItem(ACCOUNT_REGISTRY_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(validAccount)
      .map(account => ({ ...account, pubkey: account.pubkey.toLowerCase() }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch {
    return [];
  }
}

export function rememberDeviceAccount(account: DeviceAccount): DeviceAccount[] {
  const normalized = { ...account, pubkey: account.pubkey.toLowerCase() };
  const accounts = listDeviceAccounts().filter(item => item.pubkey !== normalized.pubkey);
  accounts.push(normalized);
  accounts.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  deviceStorage.setItem(ACCOUNT_REGISTRY_KEY, JSON.stringify(accounts));
  return accounts;
}

export function forgetDeviceAccount(pubkey: string): DeviceAccount[] {
  const normalized = pubkey.toLowerCase();
  const accounts = listDeviceAccounts().filter(account => account.pubkey !== normalized);
  deviceStorage.setItem(ACCOUNT_REGISTRY_KEY, JSON.stringify(accounts));
  return accounts;
}
