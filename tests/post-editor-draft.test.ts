import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  releasePostEditorMediaUrls,
  restoreDraftImageUploads,
  serializeCompletedDraftImages,
  type PostEditorUploadItem,
} from "@/utils/postEditorMediaDraft";
import { cacheEncryptedPreviewBestEffort } from "@/utils/postEditorMediaUpload";

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

  it("clears text, visibility and completed media together after send or discard", () => {
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

describe("post editor close and media UX", () => {
  const source = readFileSync(join(process.cwd(), "src/components/PostEditorModal.vue"), "utf8");

  it("distinguishes draft-saving close from explicit discard", () => {
    expect(source).toContain('@click="discardDraft">丢弃草稿</button>');
    expect(source).toContain('@click="onClose">保存草稿</button>');
    expect(source).not.toContain('@click="onClose">取消</button>');
    expect(source).toContain("function clearPersistentDraft(account: string)");
    expect(source).toContain("function resetRuntimeEditor()");
  });

  it("keeps normal route and swipe closes on the save path", () => {
    expect(source).toContain("if (ui.showPostEditor) onClose();");
    expect(source).toContain("onClose();\n        }, 220);");
    expect(source).toContain("persistDraft();\n        draftPersistenceEnabled = false;");
  });

  it("releases runtime object URLs without removing restored encrypted references", () => {
    expect(source).toContain("releasePostEditorMediaUrls(uploads.value, videoPreview.value);");
    expect(source).toContain("fullContent += `![](${img.encryptedRef})\\n`");
    expect(source).toMatch(/\.remove-btn \{[\s\S]*?opacity: 1;/);
    expect(source).not.toContain(".thumb-container:hover .remove-btn");
  });
});

describe("post editor media helpers", () => {
  const completedUpload: PostEditorUploadItem = {
    id: image.id,
    name: image.name,
    preview: "blob:runtime-preview",
    status: "done",
    progress: 100,
    encryptedRef: image.encryptedRef,
    previewEncryptedRef: image.previewEncryptedRef,
    originalMime: image.mime,
    width: image.width,
    height: image.height,
  };

  it("serializes only completed encrypted media and restores refs as sendable state", () => {
    const pending = { ...completedUpload, id: "pending", status: "uploading" as const };
    expect(serializeCompletedDraftImages([completedUpload, pending])).toEqual([image]);

    const [restored] = restoreDraftImageUploads([image]);
    expect(restored).toMatchObject({
      status: "done",
      progress: 100,
      preview: null,
      encryptedRef: image.encryptedRef,
      previewEncryptedRef: image.previewEncryptedRef,
    });
  });

  it("releases only runtime Blob URLs and never touches remote media refs", () => {
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    try {
      releasePostEditorMediaUrls(
        [completedUpload, { ...completedUpload, id: "remote", preview: "https://media.example/preview" }],
        { url: "blossom+aesgcm+video:remote", provider: "Encrypted", thumbnail: "blob:video-thumb" }
      );
      expect(revokeObjectURL.mock.calls).toEqual([["blob:runtime-preview"], ["blob:video-thumb"]]);
    } finally {
      Object.defineProperty(URL, "revokeObjectURL", { value: originalRevokeObjectURL, configurable: true });
    }
  });

  it("treats preview cache writes as best-effort", async () => {
    const cacheFailure = vi.fn().mockRejectedValue(new Error("cache unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(cacheEncryptedPreviewBestEffort(
      ACCOUNT,
      image.previewEncryptedRef,
      new File(["preview"], "preview.jpg", { type: "image/jpeg" }),
      image.mime,
      cacheFailure
    )).resolves.toBeUndefined();
    expect(cacheFailure).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
