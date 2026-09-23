import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { base64ToBytes, bytesToBase64 } from "@/nostr/crypto";
import { uploadImageToBlossomWithFallback } from "@/utils/blossom";
import { encodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import { encryptImageBytes } from "@/utils/imageCrypto";
import { storeImageInCache } from "@/utils/imageCache";
import { resizeImageFile } from "@/utils/imageResize";
import { compressImageToTargetSize } from "@/utils/imageCompression";

export async function uploadEncryptedCommentImage(
  file: File,
  options: { accountPubkey: string; signEvent: (event: EventTemplate) => Promise<VerifiedEvent> }
) {
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
  const encryptedFile = new File([base64ToBytes(encrypted.ct)], `${compressed.file.name}.encrypted`, {
    type: "application/octet-stream"
  });
  const descriptor = await uploadImageToBlossomWithFallback(encryptedFile, {
    accountPubkey: options.accountPubkey,
    signEvent: options.signEvent
  });
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const ref = encodeEncryptedImageRef({
    v: 1,
    url: descriptor.url,
    mime: compressed.file.type || "image/jpeg",
    alg: "AES-GCM",
    iv: encrypted.iv,
    key: bytesToBase64(rawKey),
    width,
    height
  });
  await storeImageInCache(options.accountPubkey, ref, compressed.file, compressed.file.type || "image/jpeg");
  return { type: "image" as const, ref, width, height };
}
