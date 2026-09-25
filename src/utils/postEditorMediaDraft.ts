import { decodeEncryptedImageRef, type EncryptedImageVariant } from "@/utils/encryptedImageRef";
import type { PostDraftImage, PostDraftVideo } from "@/utils/postDraft";

export interface PostEditorUploadItem {
  id: string;
  name: string;
  file?: File;
  preview: string | null;
  status: "pending" | "uploading" | "done" | "error";
  progress: number;
  url?: string;
  errorShort?: string;
  errorDetails?: string;
  encryptionKey?: CryptoKey;
  encryptionIv?: string;
  originalMime?: string;
  width?: number;
  height?: number;
  previewUrl?: string;
  previewEncryptionKey?: CryptoKey;
  previewEncryptionIv?: string;
  previewMime?: string;
  previewWidth?: number;
  previewHeight?: number;
  previewMetadata?: EncryptedImageVariant;
  previewEncryptedRef?: string;
  encryptedRef?: string;
}

export function serializeCompletedDraftImages(items: readonly PostEditorUploadItem[]): PostDraftImage[] {
  return items.flatMap(item => item.status === "done" && item.encryptedRef && item.previewEncryptedRef
    ? [{
        id: item.id,
        name: item.name,
        encryptedRef: item.encryptedRef,
        previewEncryptedRef: item.previewEncryptedRef,
        mime: item.originalMime || "image/jpeg",
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
      }]
    : []);
}

export function restoreDraftImageUploads(images: readonly PostDraftImage[]): PostEditorUploadItem[] {
  return images.map(image => {
    const metadata = decodeEncryptedImageRef(image.encryptedRef);
    return {
      id: image.id,
      name: image.name,
      preview: null,
      status: "done",
      progress: 100,
      url: metadata?.url,
      originalMime: image.mime,
      width: image.width,
      height: image.height,
      previewMetadata: metadata?.preview,
      previewEncryptedRef: image.previewEncryptedRef,
      encryptedRef: image.encryptedRef,
    };
  });
}

export function releaseObjectUrl(value?: string | null) {
  if (!value?.startsWith("blob:")) return;
  try { URL.revokeObjectURL(value); } catch {}
}

export function releasePostEditorMediaUrls(
  uploads: readonly Pick<PostEditorUploadItem, "preview">[],
  video: PostDraftVideo | null
) {
  for (const item of uploads) releaseObjectUrl(item.preview);
  releaseObjectUrl(video?.thumbnail);
  releaseObjectUrl(video?.url);
  releaseObjectUrl(video?.embedUrl);
}
