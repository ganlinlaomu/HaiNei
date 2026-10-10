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

  it("does not treat legacy draft defaults as explicit permission to share", () => {
    localStorage.setItem(postDraftKey(ACCOUNT)!, JSON.stringify({
      content: "legacy post", allFriends: true, selectedGroups: [], updatedAt: 1,
    }));
    expect(loadPostDraft(ACCOUNT)).toMatchObject({
      content: "legacy post", allFriends: false, selectedGroups: [], audienceChosen: false,
    });
  });

  it("remembers only explicitly selected audiences, including self-only", () => {
    savePostDraft(ACCOUNT, { content: "private", allFriends: false, selectedGroups: [], audienceChosen: true });
    expect(loadPostDraft(ACCOUNT)).toMatchObject({
      allFriends: false, selectedGroups: [], audienceChosen: true,
    });
    savePostDraft(ACCOUNT, { content: "group", allFriends: false, selectedGroups: ["家人"], audienceChosen: true });
    expect(loadPostDraft(ACCOUNT)).toMatchObject({
      allFriends: false, selectedGroups: ["家人"], audienceChosen: true,
    });
    savePostDraft(ACCOUNT, { content: "all", allFriends: true, selectedGroups: [], audienceChosen: true });
    mergeCompletedPostDraftImage(ACCOUNT, image);
    expect(loadPostDraft(ACCOUNT)).toMatchObject({
      allFriends: true, selectedGroups: [], audienceChosen: true,
    });
    savePostDraft(ACCOUNT, { content: "unselected", allFriends: true, selectedGroups: ["家人"] });
    expect(loadPostDraft(ACCOUNT)).toMatchObject({
      allFriends: false, selectedGroups: [], audienceChosen: false,
    });
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

  it("forces an explicit choice and confirms broadcast before queuePost", () => {
    expect(source).toContain("const allFriends = ref(false)");
    expect(source).toContain("const audienceChosen = ref(false)");
    expect(source).toContain("audienceChosen: audienceChosen.value");
    expect(source).toContain("visibilityOpen.value = !!audienceChosen.value && !allFriends.value && selectedGroups.value.length > 0");
    expect(source).toContain("function chooseSelf()");
    expect(source).toContain("audienceChosen.value = selectedGroups.value.length > 0");
    expect(source).toContain("if (!validAudience)");
    expect(source).toContain("visibilityRow.value?.scrollIntoView");
    expect(source).toContain("confirmationRecipients.value !== signature");
    expect(source).toContain('@click="onSend(true)"');
    expect(source).toContain("const { message } = await posts.queuePost(");
    expect(source.indexOf("if (!validAudience)")).toBeLessThan(source.indexOf("const { message } = await posts.queuePost("));
  });

  it("redesigns the publisher into content, audience cards, and a compact toolbar", () => {
    expect(source).toContain('class="editor-header-row"');
    expect(source).toContain('class="editor-author"');
    expect(source).toContain('placeholder="这一刻，你想分享什么？"');
    expect(source).toContain('class="audience-cards"');
    expect(source).toContain('aria-label="可见范围"');
    expect(source).toContain("仅自己");
    expect(source).toContain("指定分组");
    expect(source).toContain("全部好友");
    expect(source).toContain('class="group-picker"');
    expect(source).toContain('class="composer-toolbar"');
    expect(source).toContain('@click="insertMentionTrigger"');
    expect(source).toContain("@click=\"onSend()\"");
    expect(source).toContain(".audience-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(source).toContain(".editor-textarea::placeholder { color: #94a3b8; }");
  });

  it("shows Save, Discard and Continue only after cancelling a nonempty post", () => {
    expect(source).toContain('@click="requestCancel">取消</button>');
    expect(source).toContain('@click.self="requestCancel"');
    expect(source).toContain("useDialogFocus(editorCard, () => ui.showPostEditor, requestCancel)");
    expect(source).toContain('v-if="cancelSheetOpen"');
    expect(source).toContain('@click="saveAndClose">保存草稿</button>');
    expect(source).toContain('@click="discardDraft">放弃</button>');
    expect(source).toContain('@click="continueEditing">继续编辑</button>');
    expect(source).not.toContain('@click="onClose">保存草稿</button>');
    expect(source).toContain("function requestCancel()");
    expect(source).toContain("if (!draftReady.value || !draftPersistenceEnabled)");
    expect(source).toContain('rows="6" :disabled="!draftReady || !!pendingPostRetry"');
    expect(source).toContain("draftReady.value = true;");
    expect(source).toContain("if (!hasDraftContent)");
    expect(source).toContain("function saveAndClose()");
    expect(source).toContain("persistDraft();\n      onClose();");
    expect(source).toContain("function clearPersistentDraft(account: string)");
    expect(source).toContain("function resetRuntimeEditor()");
  });

  it("keeps normal route and swipe closes on the save path", () => {
    expect(source).toContain("if (ui.showPostEditor) onClose();");
    expect(source).toContain("requestCancel();");
    expect(source).toContain("shouldDismissPostEditor(distance, velocity");
    expect(source).toContain("persistDraft();\n        draftPersistenceEnabled = false;");
  });

  it("cancels uploads only for destructive lifecycle events and shares one image cancellation signal", () => {
    expect(source).toContain("function cancelUpload(id: string, discardResult = true)");
    expect(source).toContain("if (item) cancelUpload(item.id);");
    expect(source).toContain("cancelUploadsForAccount(account);");
    expect(source).toContain("if (active.account !== account) cancelUpload(id);");
    expect(source).toContain("cancelAllUploads();");
    expect(source).toContain("clearPostDraft(account);");
    expect(source).toContain("}, uploadController.signal),");
    expect(source).toContain("signal: uploadController.signal");
    expect(source).toContain("function onClose() {\n      ui.closePostEditor();\n    }");
    expect(source).not.toContain("function onClose() {\n      cancelAllUploads");
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
