import { uploadImageToBlossomWithFallback } from "@/utils/blossom";
import { storeImageInCache } from "@/utils/imageCache";
import { encryptVideoFile } from "@/utils/videoCrypto";
import { bytesToBase64 } from "@/nostr/crypto";

export interface PreparedEncryptedImage {
  encryptedFile: File;
  key: CryptoKey;
  iv: string;
  mime: string;
}

export interface PreparedEncryptedVideo {
  encryptedFile: File;
  key: CryptoKey;
  iv: string;
  mime: string;
}

type SignEvent = (event: any) => any;
type PreviewCacheWriter = (
  account: string,
  encryptedRef: string,
  file: Blob,
  mime: string
) => Promise<unknown>;

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function imageDimensions(file: File): Promise<[number, number]> {
  const bitmap = await createImageBitmap(file);
  const dimensions: [number, number] = [bitmap.width, bitmap.height];
  bitmap.close();
  return dimensions;
}

export async function prepareEncryptedImage(file: File): Promise<PreparedEncryptedImage> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    await file.arrayBuffer()
  );
  const encryptedFile = new File(
    [encryptedBytes],
    file.name.replace(/\.[^.]*$/, "") + ".enc",
    { type: "application/octet-stream" }
  );
  return { encryptedFile, key, iv: bytesToBase64(iv), mime: file.type || "image/jpeg" };
}

export async function uploadPreparedImage(
  prepared: PreparedEncryptedImage,
  accountPubkey: string,
  signEvent: SignEvent,
  onProgress: (progress: number) => void
) {
  const descriptor = await uploadImageToBlossomWithFallback(prepared.encryptedFile, {
    accountPubkey,
    signEvent,
    onProgress,
  });
  return { url: descriptor.url, key: prepared.key, iv: prepared.iv, mime: prepared.mime };
}

export async function prepareEncryptedVideo(file: File): Promise<PreparedEncryptedVideo> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const mime = file.type || "video/mp4";
  const { encryptedBytes, iv } = await encryptVideoFile(file, key);
  const encryptedFile = new File(
    [ownedBuffer(encryptedBytes)],
    file.name.replace(/\.[^.]*$/, "") + ".enc",
    { type: "application/octet-stream" }
  );
  return { encryptedFile, key, iv, mime };
}

export async function cacheEncryptedPreviewBestEffort(
  account: string,
  encryptedRef: string,
  file: File,
  mime: string,
  cacheWriter: PreviewCacheWriter = storeImageInCache
) {
  try {
    await cacheWriter(account, encryptedRef, file, mime);
  } catch (error) {
    console.warn("draft preview cache failed", error);
  }
}
