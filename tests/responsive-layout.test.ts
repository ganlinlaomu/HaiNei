import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("responsive application layout", () => {
  it("keeps mobile bottom navigation and switches to tablet/desktop rail variables", () => {
    const styles = source("src/styles.css");
    expect(styles).toContain("--bottom-nav-height: 80px");
    expect(styles).toMatch(/@media \(min-width: 768px\)[\s\S]*?--bottom-nav-height: 0px/);
    expect(styles).toMatch(/@media \(min-width: 768px\)[\s\S]*?--navigation-rail-width: 72px/);
    expect(styles).toMatch(/@media \(min-width: 1200px\)[\s\S]*?--navigation-rail-width: 84px/);
    expect(styles).toMatch(/--main-content-max-width: 860px/);
    expect(styles).toMatch(/--main-content-max-width: 1000px/);
    expect(styles).toMatch(/body > #app \{[\s\S]*?max-width: none;[\s\S]*?var\(--navigation-rail-width\)/);
  });

  it("uses the same HeaderBar as a fixed left rail without viewport JavaScript", () => {
    const header = source("src/components/HeaderBar.vue");
    expect(header).toMatch(/@media \(min-width: 768px\)[\s\S]*?\.bottom-nav \{[\s\S]*?top: 0;[\s\S]*?width: var\(--navigation-rail-width\);[\s\S]*?flex-direction: column/);
    expect(header).not.toMatch(/innerWidth|matchMedia/);
    expect((header.match(/<router-link/g) || [])).toHaveLength(4);
  });

  it("removes mobile navigation offsets from desktop FAB and dialogs", () => {
    const app = source("src/App.vue");
    const editor = source("src/components/PostEditorModal.vue");
    const conversationSheet = source("src/components/NewConversationSheet.vue");
    const commentSheet = source("src/components/CommentSheet.vue");

    expect(app).toMatch(/@media \(min-width: 768px\)[\s\S]*?\.compose-fab \{[\s\S]*?bottom: 28px/);
    expect(app).toContain("inset: 0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom)) 0");
    expect(editor).toContain("bottom: var(--bottom-nav-height)");
    expect(editor).toMatch(/@media \(min-width:768px\)[\s\S]*?\.editor-overlay \{[\s\S]*?bottom: 0;[\s\S]*?align-items: center/);
    expect(conversationSheet).toMatch(/@media \(min-width:768px\)\{\.sheet-backdrop\{align-items:center/);
    expect(commentSheet).toMatch(/@media\(min-width:768px\)\{\.comment-sheet-backdrop\{align-items:center/);
  });

  it("uses the responsive navigation variable for Home notification jumps", () => {
    const home = source("src/views/Home.vue");
    expect(home).toContain("bottomNavigationHeight()");
    expect(home).not.toContain("const BOTTOM_NAV_HEIGHT = 80");
  });
});
