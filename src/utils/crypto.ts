/**
 * WebCrypto utilities for secure private key encryption
 * Uses AES-GCM with PBKDF2 for password-based encryption
 */

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export type EncryptedData = {
  ciphertext: string; // base64
  salt: string; // base64
  iv: string; // base64
  iterations: number;
};

/**
 * Derive an encryption key from a password using PBKDF2
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: ownedBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Convert Uint8Array to base64 string (safe for large arrays)
 */
function arrayToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array
 */
function base64ToArray(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert Uint8Array to base64 string (exported for external use)
 */
export function uint8ArrayToBase64(arr: Uint8Array): string {
  return arrayToBase64(arr);
}

/**
 * Convert base64 string to Uint8Array (exported for external use)
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  return base64ToArray(base64);
}

/**
 * Encrypt a private key with a password
 * @param skHex - The private key in hex format
 * @param password - The password to encrypt with
 * @returns EncryptedData object
 */
export async function encryptPrivateKey(
  skHex: string,
  password: string
): Promise<EncryptedData> {
  // Generate random salt and IV
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Derive encryption key from password
  const key = await deriveKey(password, salt);

  // Encrypt the private key
  const encoder = new TextEncoder();
  const data = encoder.encode(skHex);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    data
  );

  return {
    ciphertext: arrayToBase64(new Uint8Array(ciphertext)),
    salt: arrayToBase64(salt),
    iv: arrayToBase64(iv),
    iterations: PBKDF2_ITERATIONS
  };
}

/**
 * Decrypt a private key with a password
 * @param encrypted - The encrypted data
 * @param password - The password to decrypt with
 * @returns The decrypted private key in hex format
 */
export async function decryptPrivateKey(
  encrypted: EncryptedData,
  password: string
): Promise<string> {
  // Convert base64 strings back to Uint8Array
  const salt = base64ToArray(encrypted.salt);
  const iv = base64ToArray(encrypted.iv);
  const ciphertext = base64ToArray(encrypted.ciphertext);

  // Derive decryption key from password
  const key = await deriveKey(password, salt);

  // Decrypt the data
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ownedBuffer(iv) },
      key,
      ownedBuffer(ciphertext)
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (e) {
    throw new Error("解密失败：密码错误或数据损坏");
  }
}

/**
 * Check if there is an encrypted private key in storage for the given public key
 */
export function hasEncryptedKey(pkHex: string): boolean {
  try {
    const key = `encrypted_sk_${pkHex}`;
    const raw = localStorage.getItem(key);
    return !!raw;
  } catch {
    return false;
  }
}

/**
 * Store encrypted private key in localStorage
 */
export function storeEncryptedKey(pkHex: string, encrypted: EncryptedData): void {
  const key = `encrypted_sk_${pkHex}`;
  localStorage.setItem(key, JSON.stringify(encrypted));
}

/**
 * Retrieve encrypted private key from localStorage
 */
export function retrieveEncryptedKey(pkHex: string): EncryptedData | null {
  try {
    const key = `encrypted_sk_${pkHex}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as EncryptedData;
  } catch {
    return null;
  }
}

/**
 * Remove encrypted private key from localStorage
 */
export function removeEncryptedKey(pkHex: string): void {
  try {
    const key = `encrypted_sk_${pkHex}`;
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
