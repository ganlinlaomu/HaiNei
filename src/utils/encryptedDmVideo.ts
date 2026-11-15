import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { uploadImageToBlossomWithFallback } from "@/utils/blossom";
import { encodeEncryptedVideoRef } from "@/utils/encryptedVideoRef";
import { encryptVideoFile, exportKeyToBase64 } from "@/utils/videoCrypto";
import { MAX_DM_VIDEO_BYTES } from "@/nostr/messaging/privateMedia";
import type { PreparedEncryptedDmVideo } from "@/db/dexie";

export async function prepareEncryptedDmVideo(file: Blob, name = "video.mp4"): Promise<PreparedEncryptedDmVideo> {
  const mime = file.type || "video/mp4";
  if (!mime.startsWith("video/")) throw new Error("视频格式不可用");
  if (!file.size || file.size > MAX_DM_VIDEO_BYTES) throw new Error("视频不能超过 25MB");
  const source = file instanceof File ? file : new File([file], name, { type: mime });
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const { encryptedBytes, iv } = await encryptVideoFile(source, key);
  const owned = new Uint8Array(encryptedBytes.byteLength);
  owned.set(encryptedBytes);
  return {
    encryptedBytes: owned.buffer,
    encryptedName: `video-${Date.now()}.encrypted`,
    mime,
    iv,
    key: await exportKeyToBase64(key),
    size: file.size,
  };
}

export async function uploadPreparedEncryptedDmVideo(
  prepared: PreparedEncryptedDmVideo,
  options: {
    accountPubkey: string;
    signEvent: (event: EventTemplate) => Promise<VerifiedEvent>;
    signal?: AbortSignal;
  },
) {
  const encryptedFile = new File([prepared.encryptedBytes], prepared.encryptedName, { type: "application/octet-stream" });
  const descriptor = await uploadImageToBlossomWithFallback(encryptedFile, options);
  return {
    encryptedRef: encodeEncryptedVideoRef({
      v: 1,
      url: descriptor.url,
      mime: prepared.mime,
      alg: "AES-GCM",
      iv: prepared.iv,
      key: prepared.key,
      size: prepared.size,
    }),
    mime: prepared.mime,
    size: prepared.size,
  };
}
