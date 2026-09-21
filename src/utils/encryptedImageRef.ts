import { bytesToBase64, base64ToBytes } from "@/nostr/crypto";

/**
 * Encrypted image reference metadata
 */
export interface EncryptedImageVariant {
  url: string;        // Blossom URL for encrypted blob
  mime: string;       // original mime type (e.g., "image/jpeg")
  alg: string;        // encryption algorithm ("AES-GCM")
  iv: string;         // base64-encoded IV (12 bytes for AES-GCM)
  key: string;        // base64-encoded key (32 bytes for AES-256)
  width?: number;
  height?: number;
}

export interface EncryptedImageMetadata extends EncryptedImageVariant {
  v: 1 | 2;
  preview?: EncryptedImageVariant;
}

function isVariant(value: unknown): value is EncryptedImageVariant {
  const item = value as Partial<EncryptedImageVariant> | null;
  return !!item && !!item.url && !!item.mime && item.alg === "AES-GCM" && !!item.iv && !!item.key;
}

export function variantToEncryptedImageRef(variant: EncryptedImageVariant): string {
  return encodeEncryptedImageRef({ v: 1, ...variant });
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
      (metadata.v !== 1 && metadata.v !== 2) ||
      !isVariant(metadata) ||
      (metadata.preview !== undefined && !isVariant(metadata.preview))
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
