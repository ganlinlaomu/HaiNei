import { deviceStorage } from "@/services/deviceStorage";
import { validTaskDue } from "@/utils/todoPlanning";

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

/** What the composer creates: a shared post, or a private note or to-do list. */
export type ComposerType = "post" | "note" | "todo";

/** Same task fields as the private-space to-do editor (including optional due). */
export interface ComposerTodoTask {
  id: string;
  text: string;
  done: boolean;
  due?: number;
}

/** Normalize a stored draft without trusting corrupted or legacy task fields. */
export function normalizeComposerTodoTasks(value: unknown): ComposerTodoTask[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: ComposerTodoTask[] = [];
  for (const item of value) {
    if (normalized.length >= 1000) break;
    if (!item || typeof item !== "object") continue;
    const task = item as Partial<ComposerTodoTask>;
    if (typeof task.id !== "string" || !task.id.trim() || seen.has(task.id) || typeof task.text !== "string") continue;
    seen.add(task.id);
    normalized.push({
      id: task.id,
      text: task.text.slice(0, 2000),
      done: task.done === true,
      ...(validTaskDue(task.due) ? { due: task.due } : {}),
    });
  }
  return normalized;
}

/** Existing editor drafts stored one task per line without stable IDs/due. */
export function composerTodoTasksFromText(content: string): ComposerTodoTask[] {
  return content.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 1000)
    .map(text => ({ id: crypto.randomUUID(), text: text.slice(0, 2000), done: false }));
}

export interface PostDraft {
  type: ComposerType;
  content: string;
  /** Title and per-item state are kept separately so dates survive editor restarts. */
  todoTitle: string;
  todoTasks: ComposerTodoTask[];
  allFriends: boolean;
  selectedGroups: string[];
  /** True only after the user explicitly chose an audience for this draft. */
  audienceChosen: boolean;
  images: PostDraftImage[];
  video: PostDraftVideo | null;
  updatedAt: number;
}

export type PostDraftInput = Omit<PostDraft, "updatedAt" | "images" | "video" | "audienceChosen" | "type" | "todoTitle" | "todoTasks"> & {
  todoTitle?: string;
  todoTasks?: ComposerTodoTask[];
  type?: ComposerType;
  audienceChosen?: boolean;
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
    // Drafts saved by older releases did not record explicit consent.
    // Restore their content/media, but require a fresh audience choice.
    const audienceChosen = value.audienceChosen === true;
    const allFriends = audienceChosen && value.allFriends === true;
    const selfOnly = audienceChosen && !allFriends && !(Array.isArray(value.selectedGroups) && value.selectedGroups.length);
    // "Only me" posts became notes; older self-only drafts reopen as a note.
    const type: ComposerType = value.type === "note" || value.type === "todo" || value.type === "post"
      ? value.type : selfOnly ? "note" : "post";
    return {
      type,
      content: value.content,
      todoTitle: typeof value.todoTitle === "string" ? value.todoTitle.slice(0, 500) : "",
      // Old text-only to-dos still open as editable rows.
      todoTasks: Array.isArray(value.todoTasks)
        ? normalizeComposerTodoTasks(value.todoTasks)
        : type === "todo" ? composerTodoTasksFromText(value.content) : [],
      audienceChosen,
      allFriends,
      selectedGroups: audienceChosen && !allFriends && Array.isArray(value.selectedGroups)
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
      type: draft.type ?? "post",
      content: draft.content,
      todoTitle: typeof draft.todoTitle === "string" ? draft.todoTitle.slice(0, 500) : "",
      todoTasks: normalizeComposerTodoTasks(draft.todoTasks),
      audienceChosen: draft.audienceChosen === true,
      allFriends: draft.audienceChosen === true && draft.allFriends,
      selectedGroups: draft.audienceChosen === true && !draft.allFriends ? [...draft.selectedGroups] : [],
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
    todoTitle: current?.todoTitle || "",
    todoTasks: current?.todoTasks || [],
    audienceChosen: current?.audienceChosen ?? false,
    allFriends: current?.allFriends ?? false,
    selectedGroups: current?.selectedGroups || [],
    images,
    video: current?.video || null,
  });
}

export function mergeCompletedPostDraftVideo(account: string, video: PostDraftVideo) {
  const current = loadPostDraft(account);
  savePostDraft(account, {
    content: current?.content || "",
    todoTitle: current?.todoTitle || "",
    todoTasks: current?.todoTasks || [],
    audienceChosen: current?.audienceChosen ?? false,
    allFriends: current?.allFriends ?? false,
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
