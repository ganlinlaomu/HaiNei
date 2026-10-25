import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(path, "utf8");
describe("unified primary tab pull-to-refresh", () => {
  it("shares the same gesture and visible feedback on Home, private messages, Calls, and Me", () => {
    for (const name of ["Home", "Conversations", "Calls", "Settings"]) {
      const view = read(`src/views/${name}.vue`);
      expect(view).toContain("pullDistance");
      expect(view).toContain("refreshing");
      expect(view).toContain("usePullToRefresh");
    }
    expect(read("src/views/Calls.vue")).toContain("resumeAccountMessageSync");
    expect(read("src/views/Settings.vue")).toContain("resumeAccountMessageSync");
    const hook = read("src/components/usePullToRefresh.ts");
    expect(hook).toContain('document.querySelector("body > #app")');
    expect(hook).toContain('addEventListener("touchcancel"');
  });
});
