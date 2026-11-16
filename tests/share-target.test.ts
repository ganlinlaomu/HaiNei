import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizePendingShareMeta, SHARE_INBOX_CACHE, SHARE_TTL_MS } from "@/services/shareTarget";

const origin = "http://localhost:3000";
const fileKey = `${origin}/__hainei_share__/file/0`;

describe("system share target", () => {
  it("declares a multipart share target that the service worker handles", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
    expect(manifest.share_target).toMatchObject({ action: "/share-target", method: "POST", enctype: "multipart/form-data" });
    expect(manifest.share_target.params.files[0].name).toBe("files");
    const worker = readFileSync("public/service-worker.js", "utf8");
    expect(worker).toContain("url.pathname === '/share-target'");
    expect(worker).toContain(`'${SHARE_INBOX_CACHE}'`);
    // The share inbox must survive a version update's cache cleanup.
    expect(SHARE_INBOX_CACHE.startsWith("closed-community-pwa")).toBe(false);
    expect(worker).toContain("/#/share");
  });

  it("accepts fresh shares and drops expired, empty or foreign entries", () => {
    const now = 1_800_000_000_000;
    const base = { v: 1, createdAt: now - 1000, text: "看看这个", files: [{ key: fileKey, name: "a.pdf", type: "application/pdf", size: 3 }] };
    expect(normalizePendingShareMeta(base, now, origin)).toMatchObject({ text: "看看这个", files: [{ name: "a.pdf" }] });
    expect(normalizePendingShareMeta({ ...base, createdAt: now - SHARE_TTL_MS - 1 }, now, origin)).toBeNull();
    expect(normalizePendingShareMeta({ ...base, text: "", files: [] }, now, origin)).toBeNull();
    const foreign = normalizePendingShareMeta({ ...base, files: [{ ...base.files[0], key: "https://evil.example/x" }] }, now, origin);
    expect(foreign?.files).toEqual([]);
    expect(normalizePendingShareMeta({ ...base, peer: "not-a-key" }, now, origin)?.peer).toBeUndefined();
    expect(normalizePendingShareMeta({ ...base, peer: "b".repeat(64) }, now, origin)?.peer).toBe("b".repeat(64));
  });
});
