import { nip44 } from "nostr-tools";
import type { RecoveryProvider } from "@/services/recovery/types";

const VERSION = 1;
const PBKDF2_ITERATIONS = 600_000;
const KEY_BITS = 256;

const CONTEXT: Record<RecoveryProvider, string> = {
  google: "hainei-google-backup-v1",
  apple: "hainei-apple-backup-v1",
};

type BackupEnvelopeV1 = {
  version: 1;
  provider: RecoveryProvider;
  cipher: "nip44-v2";
  kdf: "pbkdf2-sha256";
  iterations: number;
  payload: string;
};

function copyBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return source.slice().buffer;
}

function assertPrivateKey(skHex: string) {
  if (!/^[0-9a-f]{64}$/i.test(skHex)) throw new Error("恢复备份中的私钥格式无效");
}

function assertBackupKey(key: Uint8Array) {
  if (key.byteLength !== 32) throw new Error("恢复密钥长度无效");
}

export function isValidRecoveryPin(pin: string) {
  return /^\d{6,8}$/.test(pin);
}

export async function deriveRecoveryKey(
  provider: RecoveryProvider,
  subject: string,
  pin: string,
): Promise<Uint8Array> {
  if (!subject) throw new Error("恢复账号标识为空");
  if (!isValidRecoveryPin(pin)) throw new Error("恢复 PIN 必须为 6–8 位数字");

  const encoder = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(CONTEXT[provider]),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const salt = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    encoder.encode(subject),
  );
  const pinKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: copyBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    pinKey,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export function encryptRecoveryPrivateKey(
  skHex: string,
  backupKey: Uint8Array,
  provider: RecoveryProvider,
): string {
  assertPrivateKey(skHex);
  assertBackupKey(backupKey);
  const envelope: BackupEnvelopeV1 = {
    version: VERSION,
    provider,
    cipher: "nip44-v2",
    kdf: "pbkdf2-sha256",
    iterations: PBKDF2_ITERATIONS,
    payload: nip44.v2.encrypt(skHex.toLowerCase(), backupKey),
  };
  return JSON.stringify(envelope);
}

export function decryptRecoveryPrivateKey(
  serialized: string,
  backupKey: Uint8Array,
  expectedProvider: RecoveryProvider,
): string {
  assertBackupKey(backupKey);
  let parsed: Partial<BackupEnvelopeV1>;
  try {
    parsed = JSON.parse(serialized) as Partial<BackupEnvelopeV1>;
  } catch {
    throw new Error("恢复备份格式无效");
  }

  if (
    parsed.version !== VERSION
    || parsed.provider !== expectedProvider
    || parsed.cipher !== "nip44-v2"
    || parsed.kdf !== "pbkdf2-sha256"
    || parsed.iterations !== PBKDF2_ITERATIONS
    || typeof parsed.payload !== "string"
  ) {
    throw new Error("恢复备份版本或提供方不兼容");
  }

  let privateKey: string;
  try {
    privateKey = nip44.v2.decrypt(parsed.payload, backupKey);
  } catch {
    throw new Error("恢复 PIN 不正确或备份已损坏");
  }
  assertPrivateKey(privateKey);
  return privateKey.toLowerCase();
}

export const recoveryCryptoParameters = Object.freeze({
  version: VERSION,
  iterations: PBKDF2_ITERATIONS,
  pinDigits: "6-8",
});
