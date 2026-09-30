import { hasOnlyObjectKeys, validEncryptedMedia } from "./mediaSafety";
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

const IMAGE_VARIANT_KEYS = ["url", "mime", "alg", "iv", "key", "width", "height"] as const;
const IMAGE_METADATA_KEYS = ["v", ...IMAGE_VARIANT_KEYS, "preview"] as const;

function isVariant(value: unknown): value is EncryptedImageVariant {
  const item = value as Partial<EncryptedImageVariant> | null;
  return hasOnlyObjectKeys(item, IMAGE_VARIANT_KEYS) && validEncryptedMedia(item);
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
  if (typeof ref !== "string" || ref.length > 16384 || !ref.startsWith("blossom+aesgcm:")) {
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
      !hasOnlyObjectKeys(metadata, IMAGE_METADATA_KEYS) ||
      !isVariant(Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "v" && key !== "preview"))) ||
      (metadata.preview !== undefined && !isVariant(metadata.preview))
    ) {
      console.error("Invalid encrypted image metadata", { reason: "schema_validation_failed" });
      return null;
    }
    
    return metadata;
  } catch (e) {
    console.error("Failed to decode encrypted image reference", { reason: e instanceof Error ? e.name : "decode_failed" });
    return null;
  }
}

/**
 * Check if a string is an encrypted image reference
 */
export function isEncryptedImageRef(str: string): boolean {
  return Boolean(str && str.startsWith("blossom+aesgcm:"));
}
