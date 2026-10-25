import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = (path: string) => readFileSync(path, "utf8");
describe("primary tab shared design system", () => {
  it("uses the same primary header and title across all five main tabs", () => {
    for (const view of ["Home", "Conversations", "Calls", "Friends", "Settings"]) {
      const text = source(`src/views/${view}.vue`);
      expect(text, view).toContain("primary-page-header");
      expect(text, view).toContain('class="primary-page-title"');
    }
  });
  it("keeps main icon controls and plus buttons at identical dimensions", () => {
    const css = source("src/styles.css");
    expect(css).toContain(".primary-header-action");
    expect(css).toContain("width:44px;height:44px");
    expect(css).toContain(".primary-header-action svg");
    for (const view of ["Home", "Conversations", "Calls", "Friends"]) {
      expect(source(`src/views/${view}.vue`), view).toContain("primary-header-action");
    }
    for (const view of ["Conversations", "Calls", "Friends"]) {
      expect(source(`src/views/${view}.vue`), view).toContain('M12 5v14M5 12h14');
    }
  });
  it("shares 42px search bars for conversations, calls and contacts", () => {
    expect(source("src/styles.css")).toContain(".primary-page-search input");
    for (const view of ["Conversations", "Calls", "Friends"]) {
      expect(source(`src/views/${view}.vue`), view).toContain("primary-page-search");
    }
  });
});
