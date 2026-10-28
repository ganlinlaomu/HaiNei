import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("ebook search iPhone viewport stability", () => {
  const view = readFileSync("src/views/Books.vue", "utf8");
  const document = readFileSync("index.html", "utf8");

  function fontSize(selector: string): number {
    const styles = view.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] || "";
    const rule = styles.split(selector + "{")[1]?.split("}")[0] || "";
    const size = rule.match(/font-size:\s*(\d+)px/)?.[1];
    return Number(size || 0);
  }

  it("keeps Gutenberg search input at or above 16px to avoid iOS focus zoom", () => {
    expect(fontSize(".search-row input")).toBeGreaterThanOrEqual(16);
  });

  it("keeps language selector at or above 16px to avoid iOS focus zoom", () => {
    expect(fontSize(".filters select")).toBeGreaterThanOrEqual(16);
  });

  it("does not disable user pinch-to-zoom for accessibility", () => {
    expect(document).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/i);
  });
});
