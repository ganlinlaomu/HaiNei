import { base64ToBytes, bytesToBase64 } from "@/nostr/crypto";
import { uploadImageToBlossomWithFallback } from "@/utils/blossom";
import { decodeEncryptedImageRef, encodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import { encryptImageBytes } from "@/utils/imageCrypto";
import { getImageFromCache, storeImageInCache } from "@/utils/imageCache";
import { resizeImageFile } from "@/utils/imageResize";
import { downloadMedia } from "@/utils/mediaSafety";
import { createPrioritizedTaskQueue, type ScheduledTask } from "@/utils/prioritizedTaskQueue";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";

export const MAX_AVATAR_LOAD_CONCURRENCY = 4;
const avatarLoadScheduler = createPrioritizedTaskQueue(MAX_AVATAR_LOAD_CONCURRENCY);

type SharedAvatarJob = {
  controller: AbortController;
  scheduled: ScheduledTask<Blob>;
  promise: Promise<Blob>;
  consumers: number;
};

const avatarJobs = new Map<string, SharedAvatarJob>();

function consumeAvatarJob(key: string, job: SharedAvatarJob, signal?: AbortSignal) {
  job.consumers += 1;
  return new Promise<Blob>((resolve, reject) => {
    let released = false;
    const release = (abortIfUnused: boolean) => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", onAbort);
      job.consumers = Math.max(0, job.consumers - 1);
      if (abortIfUnused && job.consumers === 0 && avatarJobs.get(key) === job) {
        avatarJobs.delete(key);
        job.controller.abort();
        job.scheduled.cancel();
      }
    };
    const onAbort = () => {
      release(true);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    job.promise.then(
      blob => { if (!released) { release(false); resolve(blob); } },
      error => { if (!released) { release(false); reject(error); } },
    );
  });
}


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

export async function loadPrivateProfileAvatar(accountPubkey: string, reference: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const cached = await getImageFromCache(accountPubkey, reference);
  if (cached) return cached.blob;

  const taskKey = `${accountPubkey.toLowerCase()}:${reference}`;
  let job = avatarJobs.get(taskKey);
  if (!job) {
    const controller = new AbortController();
    const scheduled = avatarLoadScheduler.schedule(async () => {
      const metadata = decodeEncryptedImageRef(reference);
      if (!metadata || !metadata.mime.startsWith("image/")) throw new Error("头像引用无效");
      const encryptedBytes = await downloadMedia(metadata.url, 16 * 1024 * 1024, controller.signal);
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const cryptoKey = await crypto.subtle.importKey("raw", base64ToBytes(metadata.key), "AES-GCM", false, ["decrypt"]);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(metadata.iv) },
        cryptoKey,
        encryptedBytes
      );
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const blob = new Blob([decrypted], { type: metadata.mime });
      await storeImageInCache(accountPubkey, reference, blob, metadata.mime);
      return blob;
    }, 1);
    const shared: SharedAvatarJob = {
      controller,
      scheduled,
      promise: scheduled.promise,
      consumers: 0,
    };
    shared.promise.finally(() => {
      if (avatarJobs.get(taskKey) === shared) avatarJobs.delete(taskKey);
    }).catch(() => undefined);
    job = shared;
    avatarJobs.set(taskKey, job);
  }

  return consumeAvatarJob(taskKey, job, signal);
}
