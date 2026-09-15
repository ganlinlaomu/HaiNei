import { bytesToBase64, base64ToBytes } from "@/nostr/crypto";

/**
 * Encrypted image reference metadata
 */
export interface EncryptedImageMetadata {
  v: number;          // version (1)
  url: string;        // Blossom URL for encrypted blob
  mime: string;       // original mime type (e.g., "image/jpeg")
  alg: string;        // encryption algorithm ("AES-GCM")
  iv: string;         // base64-encoded IV (12 bytes for AES-GCM)
  key: string;        // base64-encoded key (32 bytes for AES-256)
}

/**
 * Encode encrypted image metadata into a reference string
 * Format: blossom+aesgcm:<base64(json)>
 */
export function encodeEncryptedImageRef(metadata: EncryptedImageMetadata): string {
  const json = JSON.stringify(metadata);
  const bytes = new TextEncoder().encode(json);
  const b64 = bytesToBase64(bytes);
  return `blossom+aesgcm:${b64}`;
}

/**
 * Decode an encrypted image reference string
 * Returns null if the format is invalid
 */
export function decodeEncryptedImageRef(ref: string): EncryptedImageMetadata | null {
  if (!ref || !ref.startsWith("blossom+aesgcm:")) {
    return null;
  }
  
  try {
    const b64 = ref.slice("blossom+aesgcm:".length);
    const bytes = base64ToBytes(b64);
    const json = new TextDecoder().decode(bytes);
    const metadata = JSON.parse(json) as EncryptedImageMetadata;
    
    // Basic validation
    if (
      metadata.v !== 1 ||
      !metadata.url ||
      !metadata.mime ||
      metadata.alg !== "AES-GCM" ||
      !metadata.iv ||
      !metadata.key
    ) {
      console.error("Invalid encrypted image metadata:", metadata);
      return null;
    }
    
    return metadata;
  } catch (e) {
    console.error("Failed to decode encrypted image reference:", ref, e);
    return null;
  }
}

/**
 * Check if a string is an encrypted image reference
 */
export function isEncryptedImageRef(str: string): boolean {
  return Boolean(str && str.startsWith("blossom+aesgcm:"));
}
