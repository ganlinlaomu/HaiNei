import { base64ToBytes, bytesToBase64 } from "@/nostr/crypto";
import { uploadImageToBlossomWithFallback } from "@/utils/blossom";
import { decodeEncryptedImageRef, encodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import { encryptImageBytes } from "@/utils/imageCrypto";
import { getImageFromCache, storeImageInCache } from "@/utils/imageCache";
import { resizeImageFile } from "@/utils/imageResize";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";

export async function uploadPrivateProfileAvatar(
  file: File,
  options: { accountPubkey: string; signEvent: (event: EventTemplate) => Promise<VerifiedEvent> }
) {
  const resized = await resizeImageFile(file, { maxSize: 512, quality: 0.78, outputType: "image/jpeg" });
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const encrypted = await encryptImageBytes(key, new Uint8Array(await resized.arrayBuffer()));
  const encryptedFile = new File([base64ToBytes(encrypted.ct)], `${resized.name}.encrypted`, {
    type: "application/octet-stream"
  });
  const descriptor = await uploadImageToBlossomWithFallback(encryptedFile, {
    accountPubkey: options.accountPubkey,
    signEvent: options.signEvent
  });
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const reference = encodeEncryptedImageRef({
    v: 1,
    url: descriptor.url,
    mime: resized.type || "image/jpeg",
    alg: "AES-GCM",
    iv: encrypted.iv,
    key: bytesToBase64(rawKey)
  });
  await storeImageInCache(options.accountPubkey, reference, resized, resized.type || "image/jpeg");
  return reference;
}

export async function loadPrivateProfileAvatar(accountPubkey: string, reference: string) {
  const cached = await getImageFromCache(accountPubkey, reference);
  if (cached) return cached.blob;
  const metadata = decodeEncryptedImageRef(reference);
  if (!metadata) throw new Error("头像引用无效");
  const response = await fetch(metadata.url);
  if (!response.ok) throw new Error(`头像下载失败 (${response.status})`);
  const key = await crypto.subtle.importKey("raw", base64ToBytes(metadata.key), "AES-GCM", false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(metadata.iv) },
    key,
    await response.arrayBuffer()
  );
  const blob = new Blob([decrypted], { type: metadata.mime });
  await storeImageInCache(accountPubkey, reference, blob, metadata.mime);
  return blob;
}
