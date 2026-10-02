import { deviceStorage, putDeviceValue, removeDeviceValue } from "@/services/deviceStorage";

const STORAGE_PREFIX = "biometric_unlock_";
const VERSION = 1;
const IV_LENGTH = 12;
const RANDOM_LENGTH = 32;

type BiometricUnlockRecord = {
  version: number;
  rpId: string;
  credentialId: string;
  prfSalt: string;
  iv: string;
  ciphertext: string;
};

type PrfExtensionResults = {
  prf?: {
    enabled?: boolean;
    results?: {
      first?: ArrayBuffer;
    };
  };
};

function storageKey(pubkey: string) {
  return `${STORAGE_PREFIX}${pubkey.toLowerCase()}`;
}

function copyBuffer(input: ArrayBuffer | Uint8Array): ArrayBuffer {
  const view = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

function randomBytes(length = RANDOM_LENGTH) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bytesToBase64Url(input: ArrayBuffer | Uint8Array) {
  const bytes = new Uint8Array(copyBuffer(input));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hexToBytes(hex: string) {
  const normalized = hex.toLowerCase();
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function currentRpId() {
  return typeof location === "undefined" ? "" : location.hostname;
}

function readRecord(pubkey: string): BiometricUnlockRecord | null {
  if (!pubkey) return null;
  try {
    const raw = deviceStorage.getItem(storageKey(pubkey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BiometricUnlockRecord;
    if (
      parsed.version !== VERSION
      || !parsed.credentialId
      || !parsed.prfSalt
      || !parsed.iv
      || !parsed.ciphertext
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function prfOutput(credential: PublicKeyCredential) {
  const results = credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & PrfExtensionResults;
  const first = results.prf?.results?.first;
  return first ? copyBuffer(first) : null;
}

async function aesKeyFromPrf(secret: ArrayBuffer) {
  return crypto.subtle.importKey("raw", secret, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptPrivateKey(skHex: string, secret: ArrayBuffer) {
  const key = await aesKeyFromPrf(secret);
  const iv = randomBytes(IV_LENGTH);
  const plaintext = new TextEncoder().encode(skHex);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: copyBuffer(iv) },
    key,
    copyBuffer(plaintext),
  );
  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

async function decryptPrivateKey(record: BiometricUnlockRecord, secret: ArrayBuffer) {
  const key = await aesKeyFromPrf(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: copyBuffer(base64UrlToBytes(record.iv)) },
    key,
    copyBuffer(base64UrlToBytes(record.ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}

async function evaluatePrf(credentialId: string, salt: Uint8Array, rpId: string) {
  const credentialBytes = base64UrlToBytes(credentialId);
  const challenge = randomBytes();
  const request = {
    challenge: copyBuffer(challenge),
    rpId,
    allowCredentials: [{
      type: "public-key",
      id: copyBuffer(credentialBytes),
      transports: ["internal"],
    }],
    userVerification: "required",
    timeout: 60_000,
    extensions: {
      prf: {
        evalByCredential: {
          [credentialId]: { first: copyBuffer(salt) },
        },
      },
    },
  } as unknown as PublicKeyCredentialRequestOptions;

  const credential = await navigator.credentials.get({ publicKey: request });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("通行密钥验证失败");
  const output = prfOutput(credential);
  if (!output) throw new Error("此设备暂不支持通行密钥私钥解锁");
  return output;
}

export function hasBiometricUnlock(pubkey: string) {
  const record = readRecord(pubkey);
  if (!record) return false;
  const rpId = currentRpId();
  return !!rpId && record.rpId === rpId;
}

export async function supportsBiometricUnlock() {
  if (
    typeof window === "undefined"
    || !window.isSecureContext
    || typeof PublicKeyCredential === "undefined"
    || !navigator.credentials
    || typeof navigator.credentials.create !== "function"
    || typeof navigator.credentials.get !== "function"
  ) return false;

  // Do not hide passkey unlock solely because UVPAA reports false or throws.
  // iOS/WebKit can report a conservative preflight result in installed PWA
  // contexts even when a platform WebAuthn ceremony can still succeed.
  // The real create/get ceremony remains the source of truth.
  return true;
}

export async function enrollBiometricUnlock(pubkey: string, skHex: string) {
  if (!(await supportsBiometricUnlock())) throw new Error("此设备暂不支持通行密钥登录");
  const rpId = currentRpId();
  if (!rpId) throw new Error("通行密钥登录需要安全的 HTTPS 环境");

  const salt = randomBytes();
  const challenge = randomBytes();
  const userId = hexToBytes(pubkey);
  const creation = {
    challenge: copyBuffer(challenge),
    rp: { name: "HaiNei", id: rpId },
    user: {
      id: copyBuffer(userId),
      name: `hainei-${pubkey.slice(0, 12)}`,
      displayName: "HaiNei",
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "required",
    },
    attestation: "none",
    timeout: 60_000,
    extensions: {
      prf: {
        eval: { first: copyBuffer(salt) },
      },
    },
  } as unknown as PublicKeyCredentialCreationOptions;

  const created = await navigator.credentials.create({ publicKey: creation });
  if (!(created instanceof PublicKeyCredential)) throw new Error("无法创建通行密钥登录凭证");

  const credentialId = bytesToBase64Url(created.rawId);
  let secret = prfOutput(created);
  if (!secret) secret = await evaluatePrf(credentialId, new Uint8Array(copyBuffer(salt)), rpId);

  const encrypted = await encryptPrivateKey(skHex, secret);
  const record: BiometricUnlockRecord = {
    version: VERSION,
    rpId,
    credentialId,
    prfSalt: bytesToBase64Url(salt),
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
  };
  await putDeviceValue(storageKey(pubkey), JSON.stringify(record));
}

export async function unlockPrivateKeyWithBiometric(pubkey: string) {
  const record = readRecord(pubkey);
  if (!record) throw new Error("尚未启用通行密钥登录");
  const rpId = currentRpId();
  if (!rpId || record.rpId !== rpId) throw new Error("通行密钥登录只可在原绑定地址使用");
  const salt = new Uint8Array(copyBuffer(base64UrlToBytes(record.prfSalt)));
  const secret = await evaluatePrf(record.credentialId, salt, rpId);
  try {
    return await decryptPrivateKey(record, secret);
  } catch {
    throw new Error("通行密钥解锁数据失败，请重新输入私钥恢复账号");
  }
}

export async function removeBiometricUnlock(pubkey: string) {
  if (!pubkey) return;
  await removeDeviceValue(storageKey(pubkey));
}
