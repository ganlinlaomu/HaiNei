import { deviceStorage } from "@/services/deviceStorage";

export interface PostDraftImage {
  id: string;
  name: string;
  encryptedRef: string;
  previewEncryptedRef: string;
  mime: string;
  width?: number;
  height?: number;
}

export interface PostDraftVideo {
  url: string;
  provider: string;
  embedUrl?: string;
  thumbnail?: string;
}

export interface PostDraft {
  content: string;
  allFriends: boolean;
  selectedGroups: string[];
  images: PostDraftImage[];
  video: PostDraftVideo | null;
  updatedAt: number;
}

export type PostDraftInput = Omit<PostDraft, "updatedAt" | "images" | "video"> & {
  images?: PostDraftImage[];
  video?: PostDraftVideo | null;
};

function serializableImage(value: unknown): PostDraftImage | null {
  const image = value as Partial<PostDraftImage> | null;
  if (!image
    || typeof image.id !== "string"
    || typeof image.name !== "string"
    || typeof image.encryptedRef !== "string"
    || !image.encryptedRef.startsWith("blossom+aesgcm:")
    || typeof image.previewEncryptedRef !== "string"
    || !image.previewEncryptedRef.startsWith("blossom+aesgcm:")
    || typeof image.mime !== "string") return null;
  return {
    id: image.id,
    name: image.name,
    encryptedRef: image.encryptedRef,
    previewEncryptedRef: image.previewEncryptedRef,
    mime: image.mime,
    ...(Number.isFinite(image.width) ? { width: image.width } : {}),
    ...(Number.isFinite(image.height) ? { height: image.height } : {}),
  };
}

function serializableVideo(value: unknown): PostDraftVideo | null {
  const video = value as Partial<PostDraftVideo> | null;
  if (!video
    || typeof video.url !== "string"
    || video.url.startsWith("blob:")
    || typeof video.provider !== "string") return null;
  return {
    url: video.url,
    provider: video.provider,
    ...(typeof video.embedUrl === "string" && !video.embedUrl.startsWith("blob:") ? { embedUrl: video.embedUrl } : {}),
    ...(typeof video.thumbnail === "string" && !video.thumbnail.startsWith("blob:") ? { thumbnail: video.thumbnail } : {}),
  };
}

export function postDraftKey(account?: string | null) {
  const normalized = account?.trim().toLowerCase();
  return normalized ? `nostr_post_draft_${normalized}` : null;
}

export function loadPostDraft(account?: string | null): PostDraft | null {
  const key = postDraftKey(account);
  if (!key) return null;
  try {
    const value = JSON.parse(deviceStorage.getItem(key) || "null") as Partial<PostDraft> | null;
    if (!value || typeof value.content !== "string") return null;
    const images = Array.isArray(value.images)
      ? value.images.map(serializableImage).filter((image): image is PostDraftImage => !!image)
      : [];
    const video = serializableVideo(value.video);
    return {
      content: value.content,
      allFriends: value.allFriends !== false,
      selectedGroups: Array.isArray(value.selectedGroups)
        ? value.selectedGroups.filter(group => typeof group === "string")
        : [],
      images,
      video,
      updatedAt: Number(value.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function savePostDraft(account: string | null | undefined, draft: PostDraftInput) {
  const key = postDraftKey(account);
  if (!key) return;
  try {
    deviceStorage.setItem(key, JSON.stringify({
      content: draft.content,
      allFriends: draft.allFriends,
      selectedGroups: [...draft.selectedGroups],
      images: (draft.images || []).map(serializableImage).filter((image): image is PostDraftImage => !!image),
      video: serializableVideo(draft.video),
      updatedAt: Date.now(),
    }));
  } catch {}
}

export function mergeCompletedPostDraftImage(account: string, image: PostDraftImage) {
  const current = loadPostDraft(account);
  const images = [...(current?.images || []).filter(item => item.id !== image.id && item.encryptedRef !== image.encryptedRef), image];
  savePostDraft(account, {
    content: current?.content || "",
    allFriends: current?.allFriends ?? true,
    selectedGroups: current?.selectedGroups || [],
    images,
    video: current?.video || null,
  });
}

export function mergeCompletedPostDraftVideo(account: string, video: PostDraftVideo) {
  const current = loadPostDraft(account);
  savePostDraft(account, {
    content: current?.content || "",
    allFriends: current?.allFriends ?? true,
    selectedGroups: current?.selectedGroups || [],
    images: current?.images || [],
    video,
  });
}

export function clearPostDraft(account?: string | null) {
  const key = postDraftKey(account);
  if (!key) return;
  try { deviceStorage.removeItem(key); } catch {}
}
