/**
 * secure.ts
 * - PBKDF2 密码派生 + AES-GCM 对称加密用于在浏览器中加密私钥并持久化到 IndexedDB。
 *
 * 注意：
 * - 本实现使用 PBKDF2 + SHA-256；如需更强抗 GPU 攻击的 KDF，推荐在服务端或使用 scrypt/Argon2（需额外库）。
 * - iterations 设置为 200000（权衡安全/性能）。如果目标设备较弱，可调小；若更安全可调大。
 *
 * 提供函数：
 * - encryptSkWithPassword(skHex, password) -> { salt, iv, ciphertext, iterations } (all base64/string)
 * - decryptSkWithPassword(encObj, password) -> skHex
 * - utils: bytes <-> base64
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToBytes(b64: string) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function deriveKeyFromPassword(password: string, salt: Uint8Array, iterations = 200000) {
  const pwKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: ownedBuffer(salt), iterations, hash: "SHA-256" },
    pwKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  return key;
}

export async function encryptSkWithPassword(skHex: string, password: string, iterations = 200000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveKeyFromPassword(password, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, enc.encode(skHex));
  return {
    salt: bytesToBase64(salt),
    iv: bytesToBase64(new Uint8Array(iv)),
    ciphertext: bytesToBase64(new Uint8Array(ct)),
    iterations
  };
}

export async function decryptSkWithPassword(encObj: { salt: string; iv: string; ciphertext: string; iterations?: number }, password: string) {
  const salt = base64ToBytes(encObj.salt);
  const iv = base64ToBytes(encObj.iv);
  const ct = base64ToBytes(encObj.ciphertext);
  const iterations = encObj.iterations || 200000;
  const aesKey = await deriveKeyFromPassword(password, salt, iterations);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ct);
  return dec.decode(plainBuf); // skHex
}

export function exportEncryptedBlob(encObj: any) {
  const dataStr = JSON.stringify(encObj, null, 2);
  const blob = new Blob([dataStr], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  return { url, blob, name: `nostr-key-backup-${Date.now()}.json` };
}

export async function readJsonFile(file: File) {
  return await file.text();
}
