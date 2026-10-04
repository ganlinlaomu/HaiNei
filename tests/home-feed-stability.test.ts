import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Home feed stability contract", () => {
  it("keeps card presentation and interaction ownership inside PostCard", () => {
    const home = readFileSync(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const card = readFileSync(join(process.cwd(), "src/components/PostCard.vue"), "utf8");

    expect(home).toContain("<PostCard");
    expect(home).toContain('@height="recordPostHeight"');
    expect(home).not.toContain("function toggleLike(");
    expect(home).not.toContain("function addComment(");
    expect(home).not.toContain("function startReply(");
    expect(home).not.toContain("showingComments");
    expect(home).not.toContain("commentInputs");
    expect(home).not.toContain("expandedPosts");
    expect(home).not.toContain("showingSendMeta");

    expect(card).toContain("async function toggleLike()");
    expect(card).toContain("function playLikeBounce()");
    expect(card).toContain("'like-bounce': likeAnimating");
    expect(card).toContain("@keyframes instagram-heart-pop");
    expect(card).toContain("translateY(-8px) scale(1.34)");
    expect(card).toContain("instagram-heart-pop 430ms");
    expect(card).toContain("CommentSheet");
    expect(card).toContain("const expanded = ref(false)");
    expect(card).toContain("toggleBookmark");
  });

  it("restores Home scroll after KeepAlive navigation without overriding notification jumps", () => {
    const home = readFileSync(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");

    expect(app).toContain("<keep-alive");
    expect(app).toContain("'Home'");
    expect(home).toContain('import { loadHomeScroll, saveHomeScroll } from "@/utils/homeScroll"');
    expect(home).toContain("function saveCurrentHomeScroll()");
    expect(home).toContain("async function restoreCurrentHomeScroll()");
    expect(home).toContain('if (!keys.pkHex || route.path !== "/" || hasNotificationParams(route.query)) return');
    expect(home).toContain("saveHomeScroll(keys.pkHex, scrollContainer.scrollTop)");
    expect(home).toContain("scrollContainer.scrollTop = saved");
    expect(home).toContain("onDeactivated(() =>");
    expect(home).toContain("saveCurrentHomeScroll();");
    expect(home).toContain("void restoreCurrentHomeScroll();");
    expect(home).toContain("saveHomeScroll(previousPk, scrollContainer.scrollTop)");
  });

  it("makes showing pending posts an explicit jump to the newest inserted post", () => {
    const home = readFileSync(join(process.cwd(), "src/views/Home.vue"), "utf8");

    expect(home).toContain("async function showPendingMessages()");
    expect(home).toContain("const newestPendingId = sortedPending[0]?.id");
    expect(home).toContain("virtualStart.value = 0");
    expect(home).toContain('scrollContainer.scrollTo({ top: feedElement.value.offsetTop, behavior: "smooth" })');
    expect(home).toContain('target?.classList.add("home-new-highlight")');
    expect(home).toContain("home-new-post-highlight");
  });
});
