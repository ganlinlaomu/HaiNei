import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { base64ToBytes, bytesToBase64 } from "@/nostr/crypto";
import { uploadImageToBlossomWithFallback } from "@/utils/blossom";
import { decodeEncryptedImageRef, encodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import type { PreparedEncryptedAudio } from "@/db/dexie";

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function prepareEncryptedDmAudio(blob: Blob, duration: number): Promise<PreparedEncryptedAudio> {
  const mime = blob.type || "application/octet-stream";
  if (!mime.startsWith("audio/")) throw new Error("录音格式不可用");
  const plainBytes = new Uint8Array(await blob.arrayBuffer());
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ownedArrayBuffer(plainBytes));
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return {
    encryptedBytes: ownedArrayBuffer(new Uint8Array(encrypted)),
    encryptedName: `voice-${Date.now()}.encrypted`,
    mime,
    iv: bytesToBase64(iv),
    key: bytesToBase64(rawKey),
    duration: Math.min(300, Math.max(0, duration)),
    size: blob.size,
  };
}

export async function uploadPreparedEncryptedDmAudio(
  prepared: PreparedEncryptedAudio,
  options: { accountPubkey: string; signEvent: (event: EventTemplate) => Promise<VerifiedEvent> },
) {
  const encryptedFile = new File([prepared.encryptedBytes], prepared.encryptedName, { type: "application/octet-stream" });
  const descriptor = await uploadImageToBlossomWithFallback(encryptedFile, options);
  return {
    encryptedRef: encodeEncryptedImageRef({
      v: 1,
      url: descriptor.url,
      mime: prepared.mime,
      alg: "AES-GCM",
      iv: prepared.iv,
      key: prepared.key,
    }),
    mime: prepared.mime,
    duration: prepared.duration,
    size: prepared.size,
  };
}

export async function decryptDmAudio(encryptedRef: string, signal?: AbortSignal) {
  const metadata = decodeEncryptedImageRef(encryptedRef);
  if (!metadata || !metadata.mime.startsWith("audio/")) throw new Error("无效的加密语音引用");
  const response = await fetch(metadata.url, { signal });
  if (!response.ok) throw new Error(`语音下载失败 (${response.status})`);
  const key = await crypto.subtle.importKey("raw", base64ToBytes(metadata.key), "AES-GCM", false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(metadata.iv) },
    key,
    await response.arrayBuffer(),
  );
  return new Blob([decrypted], { type: metadata.mime });
}
