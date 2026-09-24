import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { base64ToBytes, bytesToBase64 } from "@/nostr/crypto";
import { uploadImageToBlossomWithFallback } from "@/utils/blossom";
import { encodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import { encryptImageBytes } from "@/utils/imageCrypto";
import { storeImageInCache } from "@/utils/imageCache";
import { resizeImageFile } from "@/utils/imageResize";
import { compressImageToTargetSize } from "@/utils/imageCompression";
import type { PreparedEncryptedImage } from "@/db/dexie";

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function prepareEncryptedCommentImage(file: File): Promise<PreparedEncryptedImage> {
  const resized = await resizeImageFile(file, { maxSize: 1280, quality: 0.78, outputType: "image/jpeg" });
  const compressed = await compressImageToTargetSize(resized, {
    minTargetSize: 120 * 1024,
    maxTargetSize: 220 * 1024,
    maxIterations: 8
  });
  const bitmap = await createImageBitmap(compressed.file);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const encrypted = await encryptImageBytes(key, new Uint8Array(await compressed.file.arrayBuffer()));
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return {
    encryptedBytes: ownedArrayBuffer(base64ToBytes(encrypted.ct)),
    encryptedName: `${compressed.file.name}.encrypted`,
    previewBytes: await compressed.file.arrayBuffer(),
    mime: compressed.file.type || "image/jpeg",
    iv: encrypted.iv,
    key: bytesToBase64(rawKey),
    width,
    height,
  };
}

export async function uploadPreparedEncryptedCommentImage(
  prepared: PreparedEncryptedImage,
  options: { accountPubkey: string; signEvent: (event: EventTemplate) => Promise<VerifiedEvent> }
) {
  const encryptedFile = new File([prepared.encryptedBytes], prepared.encryptedName, { type: "application/octet-stream" });
  const descriptor = await uploadImageToBlossomWithFallback(encryptedFile, {
    accountPubkey: options.accountPubkey,
    signEvent: options.signEvent
  });
  const ref = encodeEncryptedImageRef({
    v: 1,
    url: descriptor.url,
    mime: prepared.mime,
    alg: "AES-GCM",
    iv: prepared.iv,
    key: prepared.key,
    width: prepared.width,
    height: prepared.height
  });
  // The encrypted upload is already complete here. A local preview-cache failure
  // must not turn a successful Blossom upload into an upload failure.
  const previewBlob = new Blob([prepared.previewBytes], { type: prepared.mime });
  await storeImageInCache(options.accountPubkey, ref, previewBlob, prepared.mime).catch(() => undefined);
  return { type: "image" as const, ref, width: prepared.width, height: prepared.height };
}

export async function uploadEncryptedCommentImage(
  file: File,
  options: {
    accountPubkey: string;
    signEvent: (event: EventTemplate) => Promise<VerifiedEvent>;
    prepared?: PreparedEncryptedImage;
    onPrepared?: (prepared: PreparedEncryptedImage) => void | Promise<void>;
  }
) {
  const prepared = options.prepared || await prepareEncryptedCommentImage(file);
  if (!options.prepared) await options.onPrepared?.(prepared);
  return uploadPreparedEncryptedCommentImage(prepared, options);
}
