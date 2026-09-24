import { deviceStorage } from "@/services/deviceStorage";

export interface PostDraft {
  content: string;
  allFriends: boolean;
  selectedGroups: string[];
  updatedAt: number;
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
    return {
      content: value.content,
      allFriends: value.allFriends !== false,
      selectedGroups: Array.isArray(value.selectedGroups)
        ? value.selectedGroups.filter(group => typeof group === "string")
        : [],
      updatedAt: Number(value.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function savePostDraft(account: string | null | undefined, draft: Omit<PostDraft, "updatedAt">) {
  const key = postDraftKey(account);
  if (!key) return;
  try { deviceStorage.setItem(key, JSON.stringify({ ...draft, updatedAt: Date.now() })); } catch {}
}

export function clearPostDraft(account?: string | null) {
  const key = postDraftKey(account);
  if (!key) return;
  try { deviceStorage.removeItem(key); } catch {}
}
