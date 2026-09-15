import { bytesToBase64, base64ToBytes } from "@/nostr/crypto";

/**
 * Encrypted video reference metadata
 * Similar structure to EncryptedImageMetadata for consistency
 */
export interface EncryptedVideoMetadata {
  v: number;          // version (1)
  url: string;        // Blossom URL for encrypted blob
  mime: string;       // original mime type (e.g., "video/mp4")
  alg: string;        // encryption algorithm ("AES-GCM")
  iv: string;         // base64-encoded IV (12 bytes for AES-GCM)
  key: string;        // base64-encoded key (32 bytes for AES-256)
  size?: number;      // optional: original file size in bytes
  duration?: number;  // optional: video duration in seconds
}

/**
 * Encode encrypted video metadata into a reference string
 * Format: blossom+aesgcm+video:<base64(json)>
 */
export function encodeEncryptedVideoRef(metadata: EncryptedVideoMetadata): string {
  const json = JSON.stringify(metadata);
  const bytes = new TextEncoder().encode(json);
  const b64 = bytesToBase64(bytes);
  return `blossom+aesgcm+video:${b64}`;
}

/**
 * Decode an encrypted video reference string
 * Returns null if the format is invalid
 */
export function decodeEncryptedVideoRef(ref: string): EncryptedVideoMetadata | null {
  if (!ref || !ref.startsWith("blossom+aesgcm+video:")) {
    return null;
  }
  
  try {
    const b64 = ref.slice("blossom+aesgcm+video:".length);
    const bytes = base64ToBytes(b64);
    const json = new TextDecoder().decode(bytes);
    const metadata = JSON.parse(json) as EncryptedVideoMetadata;
    
    // Basic validation
    if (
      metadata.v !== 1 ||
      !metadata.url ||
      !metadata.mime ||
      metadata.alg !== "AES-GCM" ||
      !metadata.iv ||
      !metadata.key
    ) {
      console.error("Invalid encrypted video metadata:", metadata);
      return null;
    }
    
    return metadata;
  } catch (e) {
    console.error("Failed to decode encrypted video reference:", ref, e);
    return null;
  }
}

/**
 * Check if a string is an encrypted video reference
 */
export function isEncryptedVideoRef(str: string): boolean {
  return Boolean(str && str.startsWith("blossom+aesgcm+video:"));
}

/**
 * Create video metadata format for content
 * This is the format stored in message content for display
 */
export interface VideoMetadataForContent {
  type: 'video';
  url: string;        // Can be either encrypted reference or plain URL
  provider: string;   // 'Encrypted' for encrypted videos, or 'YouTube', 'Vimeo', etc.
  encrypted?: boolean; // Flag to indicate if this is encrypted
  mime?: string;      // MIME type for encrypted videos
}

/**
 * Create video metadata JSON string for embedding in content
 * Format: [video:{json}]
 */
export function createVideoMetadataString(metadata: VideoMetadataForContent): string {
  return `[video:${JSON.stringify(metadata)}]`;
}
