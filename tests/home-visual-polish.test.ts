import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Home visual polish contract", () => {
  it("uses a flat mobile feed and keeps card treatment on larger screens", () => {
    const home = readFileSync(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const card = readFileSync(join(process.cwd(), "src/components/PostCard.vue"), "utf8");

    expect(home).toContain(".feed {");
    expect(home).toContain("gap: 0;");
    expect(home).toContain("padding: 0 0 20px;");
    expect(home).toContain("@media (min-width: 640px)");
    expect(home).toContain(".feed { gap:10px");

    expect(card).toContain(".post-card{background:#fff;padding:14px 16px 12px;border:0;border-bottom:1px solid #edf1f5;border-radius:0;box-shadow:none}");
    expect(card).toContain("@media(min-width:640px){.post-card:not(.force-flat){padding:16px;border:1px solid #e8edf3;border-radius:14px;box-shadow:0 2px 8px rgba(15,23,42,.035)}");
  });

  it("moves audience context into author metadata and keeps actions focused", () => {
    const card = readFileSync(join(process.cwd(), "src/components/PostCard.vue"), "utf8");
    expect(card).toContain('class="author-meta"');
    expect(card).toContain('class="audience-link"');
    expect(card).toContain('return "仅自己可见"');
    expect(card).not.toContain('class="action visibility"');
    expect(card).toContain('class="action icon-action bookmark"');
  });

  it("uses inline long-text expansion and a quieter new-post pill", () => {
    const home = readFileSync(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const card = readFileSync(join(process.cwd(), "src/components/PostCard.vue"), "utf8");

    expect(card).toContain(".text-button{display:inline-flex");
    expect(home).toContain('<span class="notification-icon">↑</span>');
    expect(home).toContain("background: rgba(255,255,255,.96)");
    expect(home).not.toContain("linear-gradient(135deg, #667eea 0%, #764ba2 100%)");
  });

  it("keeps profile activity flat regardless of wide viewport", () => {
    const card = readFileSync(join(process.cwd(), "src/components/PostCard.vue"), "utf8");
    const profile = readFileSync(join(process.cwd(), "src/views/Profile.vue"), "utf8");

    expect(card).toContain("flat?: boolean");
    expect(card).toContain("'force-flat': flat");
    expect(card).toContain(".post-card:not(.force-flat)");
    expect(profile).toContain('<PostCard v-for="post in ownerPosts" :key="post.id" :message="post" flat />');
    expect(profile).toContain(".post-list{display:grid;gap:0}");
    expect(profile).toContain(".profile-posts{width:100%;box-sizing:border-box;padding:4px 0 0}");
  });

  it("renders success feedback as compact neutral toast instead of a green block", () => {
    const toast = readFileSync(join(process.cwd(), "src/components/ToastContainer.vue"), "utf8");
    const editor = readFileSync(join(process.cwd(), "src/components/PostEditorModal.vue"), "utf8");
    const profile = readFileSync(join(process.cwd(), "src/views/MyProfile.vue"), "utf8");

    expect(toast).toContain("font-size:13px");
    expect(toast).toContain('background:rgba(255,255,255,.96)');
    expect(toast).toContain('.toast.success::before{content:"✓";color:#15803d;background:#f0fdf4}');
    expect(toast).not.toContain("background: #16a34a");
    expect(editor).toContain('ui.addToast("已发布", 1_400, "success")');
    expect(profile).toContain('ui.addToast("已保存，正在同步", 1_600, "success")');
    expect(profile).toContain('ui.addToast("同步完成", 1_600, "success")');
  });
});
