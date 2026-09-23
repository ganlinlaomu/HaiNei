import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adjacentSlideIndexes,
  carouselActiveIndex,
  carouselIndicators,
  isCarouselDoubleTap,
  shouldSendDoubleTapLike
} from "@/utils/feedCarousel";

describe("feed media carousel and actions", () => {
  it("uses one full-width active slide and only preloads adjacent slides", () => {
    expect(carouselActiveIndex(320, 320, 4)).toBe(1);
    expect(adjacentSlideIndexes(1, 4)).toEqual([0, 1, 2]);
    expect(adjacentSlideIndexes(0, 4)).toEqual([0, 1]);
    const source = readFileSync(join(process.cwd(), "src/components/PostImagePreview.vue"), "utf8");
    expect(source).toContain("flex: 0 0 100%");
    expect(source).toContain("scroll-snap-type: x mandatory");
  });

  it("matches indicator count and updates the active index after a slide change", () => {
    expect(carouselIndicators(4)).toEqual([0, 1, 2, 3]);
    expect(carouselActiveIndex(610, 300, 4)).toBe(2);
  });

  it("recognizes one double tap and suppresses duplicate likes", () => {
    expect(isCarouselDoubleTap(1_000, 1, 1_220, 1)).toBe(true);
    expect(isCarouselDoubleTap(1_000, 1, 1_220, 2)).toBe(false);
    expect(shouldSendDoubleTapLike(false, false)).toBe(true);
    expect(shouldSendDoubleTapLike(true, false)).toBe(false);
    expect(shouldSendDoubleTapLike(false, true)).toBe(false);
  });

  it("keeps comments and bookmark actions but renders no share or repost action", () => {
    const source = readFileSync(join(process.cwd(), "src/components/PostCard.vue"), "utf8");
    expect(source).toContain('aria-label="评论"');
    expect(source).toContain("@click=\"toggleComments\"");
    expect(source).toContain("@click=\"toggleBookmark\"");
    expect(source).not.toMatch(/aria-label=["'](?:分享|转发|repost|share)/i);
    expect(source).toContain("min-width:36px;min-height:36px;padding:5px 6px");
    expect(source).toContain("width:21px;height:21px");
    expect(source).toContain("gap:3px");
    expect(source).toContain("font-size:11px");
  });

  it("uses a blue saved bookmark and the existing top toast feedback", () => {
    const card = readFileSync(join(process.cwd(), "src/components/PostCard.vue"), "utf8");
    const toasts = readFileSync(join(process.cwd(), "src/components/ToastContainer.vue"), "utf8");
    expect(card).toContain(".action.bookmark.saved{color:#60A5FA}");
    expect(card).toContain('saved ? "已添加到收藏夹" : "已从收藏夹移除"');
    expect(card).toContain('1700, "bookmark"');
    expect(toasts).toContain("top: calc(env(safe-area-inset-top) + 12px)");
    expect(toasts).toContain("background: rgba(255,255,255,.94)");
    expect(toasts).toContain("color:#60A5FA");
  });

  it("shows no counter or dots for a single image", () => {
    const source = readFileSync(join(process.cwd(), "src/components/PostImagePreview.vue"), "utf8");
    expect(source).toContain('v-if="images.length > 1" class="carousel-counter"');
    expect(source).toContain('v-if="images.length > 1" class="carousel-dots"');
  });
});
