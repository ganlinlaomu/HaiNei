import { bytesToBase64, base64ToBytes } from "@/nostr/crypto";

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/* ========================
 * 视频 AES-GCM 加密/解密
 * 复用图片加密相同的逻辑和 key 格式
 * ======================== */

/**
 * Encrypt video bytes using AES-GCM
 * Same logic as image encryption for consistency
 * @param key - CryptoKey for AES-GCM encryption
 * @param plainBytes - The video bytes to encrypt
 * @returns Object with base64-encoded IV and ciphertext
 */
export async function encryptVideoBytes(
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

/**
 * Decrypt video bytes using AES-GCM
 * Same logic as image decryption for consistency
 * @param key - CryptoKey for AES-GCM decryption
 * @param pkg - Object with base64-encoded IV and ciphertext
 * @returns Decrypted video bytes
 */
export async function decryptVideoBytes(
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

/**
 * Encrypt a video file and return encrypted bytes
 * @param file - Video file to encrypt
 * @param key - CryptoKey for encryption
 * @returns Encrypted bytes and IV
 */
export async function encryptVideoFile(
  file: File,
  key: CryptoKey
): Promise<{ encryptedBytes: Uint8Array; iv: string }> {
  // Read file bytes
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  
  // Generate IV
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  
  // Encrypt
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    fileBytes
  );
  
  return {
    encryptedBytes: new Uint8Array(encrypted),
    iv: bytesToBase64(ivBytes)
  };
}

/**
 * Decrypt video bytes and create a Blob URL for playback
 * @param encryptedBytes - The encrypted video bytes
 * @param key - CryptoKey for decryption
 * @param iv - Base64-encoded IV
 * @param mimeType - Original MIME type of the video
 * @returns Blob URL for video playback
 */
export async function decryptVideoToBlob(
  encryptedBytes: Uint8Array,
  key: CryptoKey,
  iv: string,
  mimeType: string
): Promise<string> {
  // Convert encrypted bytes to base64 for decryption function
  const ct = bytesToBase64(encryptedBytes);
  
  // Decrypt
  const decryptedBytes = await decryptVideoBytes(key, { iv, ct });
  
  // Create blob with correct MIME type
  const blob = new Blob([decryptedBytes], { type: mimeType });
  
  // Create and return blob URL
  return URL.createObjectURL(blob);
}

/**
 * Generate a new AES-GCM key for video encryption
 * @returns CryptoKey for AES-GCM
 */
export async function generateVideoEncryptionKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

/**
 * Export a CryptoKey to base64 string
 * @param key - CryptoKey to export
 * @returns Base64-encoded key
 */
export async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const keyBytes = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64(new Uint8Array(keyBytes));
}

/**
 * Import a base64 key string to CryptoKey
 * @param keyBase64 - Base64-encoded key
 * @returns CryptoKey for AES-GCM
 */
export async function importKeyFromBase64(keyBase64: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(keyBase64);
  return await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
}
