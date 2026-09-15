import { bytesToBase64, base64ToBytes } from "@/nostr/crypto";

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/* ========================
 * 图片 AES-GCM 加密
 * ======================== */

export async function encryptImageBytes(
  key: CryptoKey,
  plainBytes: Uint8Array
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    ownedBuffer(plainBytes)
  );

  return {
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(encrypted))
  };
}

/* ========================
 * 图片 AES-GCM 解密
 * ======================== */

export async function decryptImageBytes(
  key: CryptoKey,
  pkg: { iv: string; ct: string }
) {
  const iv = base64ToBytes(pkg.iv);
  const ct = base64ToBytes(pkg.ct);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ownedBuffer(ct)
  );

  return new Uint8Array(decrypted);
}
