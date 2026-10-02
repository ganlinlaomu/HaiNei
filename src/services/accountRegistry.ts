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
  const normalized = { ...account, pubkey: account.pubkey.toLowerCase() };
  const accounts = listDeviceAccounts().filter(item => item.pubkey !== normalized.pubkey);
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
