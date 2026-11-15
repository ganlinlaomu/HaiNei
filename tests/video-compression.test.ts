import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compressVideoForUpload } from "@/utils/videoCompression";

afterEach(() => vi.unstubAllGlobals());

describe("video compression before upload", () => {
  it("returns the picked file untouched where WebCodecs is missing", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    const file = new File(["video"], "clip.mov", { type: "video/quicktime" });
    await expect(compressVideoForUpload(file)).resolves.toBe(file);
  });

  it("post videos are compressed before encryption, like DM videos", () => {
    const editor = readFileSync("src/components/PostEditorModal.vue", "utf8");
    const upload = editor.slice(editor.indexOf("async function startVideoUpload"));
    const compressAt = upload.indexOf("compressVideoForUpload(file");
    expect(compressAt).toBeGreaterThan(0);
    expect(compressAt).toBeLessThan(upload.indexOf("prepareEncryptedVideo(compressed)"));
    expect(upload).toContain("compressed.size > MAX_UPLOAD_VIDEO_BYTES");
    expect(upload).toContain("signal: uploadController.signal");
  });
});
