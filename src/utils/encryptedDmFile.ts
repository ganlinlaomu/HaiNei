import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import type { PreparedEncryptedDmFile } from "@/db/dexie";
import { base64ToBytes, bytesToBase64 } from "@/nostr/crypto";
import {
  decodeEncryptedFileRef,
  encodeEncryptedFileRef,
  MAX_DM_FILE_BYTES,
  normalizeDmFileMime,
  sanitizeDmFileName,
  type PrivateFileMedia,
} from "@/nostr/messaging/privateFile";
import { uploadImageToBlossomWithFallback } from "@/utils/blossom";
import { downloadMedia } from "@/utils/mediaSafety";

export async function prepareEncryptedDmFile(file: File): Promise<PreparedEncryptedDmFile> {
  if (!file.size) throw new Error("文件为空");
  if (file.size > MAX_DM_FILE_BYTES) throw new Error("文件不能超过 25MB");
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await file.arrayBuffer());
  return {
    encryptedBytes,
    encryptedName: `file-${Date.now()}.encrypted`,
    name: sanitizeDmFileName(file.name),
    mime: normalizeDmFileMime(file.type),
    iv: bytesToBase64(iv),
    key: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key))),
    size: file.size,
  };
}

export async function uploadPreparedEncryptedDmFile(
  prepared: PreparedEncryptedDmFile,
  options: {
    accountPubkey: string;
    signEvent: (event: EventTemplate) => Promise<VerifiedEvent>;
    signal?: AbortSignal;
  },
): Promise<PrivateFileMedia> {
  const encryptedFile = new File([prepared.encryptedBytes], prepared.encryptedName, { type: "application/octet-stream" });
  const descriptor = await uploadImageToBlossomWithFallback(encryptedFile, options);
  const encryptedRef = encodeEncryptedFileRef({
    v: 1, url: descriptor.url, mime: prepared.mime, alg: "AES-GCM", iv: prepared.iv, key: prepared.key, size: prepared.size,
  });
  // Fail the upload, not the chat render, if the server hands back an unusable URL.
  if (!decodeEncryptedFileRef(encryptedRef)) throw new Error("媒体服务器返回的文件地址无效");
  return {
    encryptedRef,
    name: prepared.name,
    mime: prepared.mime,
    size: prepared.size,
  };
}

/** Download and decrypt a DM file. The bytes never render inside the app origin. */
export async function downloadDecryptedDmFile(media: PrivateFileMedia, signal?: AbortSignal) {
  const metadata = decodeEncryptedFileRef(media.encryptedRef);
  if (!metadata) throw new Error("文件引用无效");
  const encrypted = await downloadMedia(metadata.url, MAX_DM_FILE_BYTES + 16, signal);
  const key = await crypto.subtle.importKey("raw", base64ToBytes(metadata.key), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(metadata.iv) }, key, encrypted);
  return new File([plain], media.name, { type: metadata.mime });
}

function isAppleMobile() {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Hand a decrypted file to the system. iOS saves through the share sheet
 * ("存储到文件"); elsewhere it is a plain download. The download blob is
 * typed octet-stream so HTML or SVG can never open as a same-origin page.
 */
export async function saveDecryptedDmFile(file: File) {
  if (isAppleMobile() && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared" as const;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled" as const;
      // The tap's activation expired while the file downloaded; ask for another tap.
      if (error instanceof DOMException && error.name === "NotAllowedError") return "needs-gesture" as const;
    }
  }
  const url = URL.createObjectURL(new Blob([file], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded" as const;
}
