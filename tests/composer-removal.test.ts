import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("composer cleanup", () => {
  it("removes the obsolete view without leaving source references", () => {
    expect(existsSync(join(process.cwd(), "src", "views", "PostEditor.vue"))).toBe(false);
    const source = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
    expect(source).not.toContain("views/" + "PostEditor.vue");
  });

  it("keeps the live modal mounted and connected to message sending", () => {
    const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
    const modal = readFileSync(join(process.cwd(), "src/components/PostEditorModal.vue"), "utf8");
    expect(app).toContain("PostEditorModal");
    expect(app).toContain("postEditorReady");
    expect(modal).toContain("posts.sendDirectMessage");
  });
});
