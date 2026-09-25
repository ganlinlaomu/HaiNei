import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPostDraft,
  loadPostDraft,
  mergeCompletedPostDraftImage,
  mergeCompletedPostDraftVideo,
  postDraftKey,
  savePostDraft,
  type PostDraftImage,
} from "@/utils/postDraft";
import { canStartPostEditorDrag, shouldDismissPostEditor } from "@/utils/postEditorGesture";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
const image: PostDraftImage = {
  id: "upload-1",
  name: "photo.jpg",
  encryptedRef: "blossom+aesgcm:original",
  previewEncryptedRef: "blossom+aesgcm:preview",
  mime: "image/jpeg",
  width: 1600,
  height: 900,
};

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => values.set(key, String(value)),
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: storage(), configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: storage(), configurable: true });
});

describe("complete post draft media", () => {
  it("restores completed image and video descriptors", () => {
    savePostDraft(ACCOUNT, {
      content: "draft",
      allFriends: false,
      selectedGroups: ["家人"],
      images: [image],
      video: { url: "blossom+aesgcm+video:encrypted", provider: "Encrypted", embedUrl: "blossom+aesgcm+video:encrypted" },
    });
    expect(loadPostDraft(ACCOUNT)).toMatchObject({ content: "draft", images: [image], video: { provider: "Encrypted" } });
  });

  it("persists only serializable media descriptor fields", () => {
    savePostDraft(ACCOUNT, {
      content: "",
      allFriends: true,
      selectedGroups: [],
      images: [{ ...image, file: { secret: true }, encryptionKey: { secret: true }, preview: "blob:local" } as any],
      video: { url: "https://video.test/watch", provider: "Web", thumbnail: "blob:local" },
    });
    const raw = localStorage.getItem(postDraftKey(ACCOUNT)!) || "";
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("blob:local");
    expect(loadPostDraft(ACCOUNT)?.images).toEqual([image]);
  });

  it("writes a delayed upload result only to its originating account draft", () => {
    savePostDraft(ACCOUNT, { content: "origin", allFriends: true, selectedGroups: [] });
    savePostDraft(OTHER, { content: "other", allFriends: true, selectedGroups: [] });
    mergeCompletedPostDraftImage(ACCOUNT, image);
    mergeCompletedPostDraftVideo(ACCOUNT, { url: "blossom+aesgcm+video:done", provider: "Encrypted" });
    expect(loadPostDraft(ACCOUNT)).toMatchObject({ content: "origin", images: [image], video: { provider: "Encrypted" } });
    expect(loadPostDraft(OTHER)).toMatchObject({ content: "other", images: [], video: null });
  });

  it("clears text, visibility and completed media together after send", () => {
    savePostDraft(ACCOUNT, {
      content: "ready",
      allFriends: true,
      selectedGroups: [],
      images: [image],
      video: { url: "blossom+aesgcm+video:done", provider: "Encrypted" },
    });
    clearPostDraft(ACCOUNT);
    expect(loadPostDraft(ACCOUNT)).toBeNull();
  });
});

describe("post editor swipe dismissal", () => {
  it("starts only at the top while moving downward", () => {
    expect(canStartPostEditorDrag(0, 12)).toBe(true);
    expect(canStartPostEditorDrag(1, 12)).toBe(false);
    expect(canStartPostEditorDrag(0, -12)).toBe(false);
  });

  it("dismisses on distance or downward velocity and otherwise springs back", () => {
    expect(shouldDismissPostEditor(180, 0.2, 600)).toBe(true);
    expect(shouldDismissPostEditor(50, 0.8, 600)).toBe(true);
    expect(shouldDismissPostEditor(50, 0.2, 600)).toBe(false);
  });
});
