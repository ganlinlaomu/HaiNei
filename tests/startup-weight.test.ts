import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("startup weight and scroll cost", () => {
  it("keeps the Google recovery panel out of the startup bundle", () => {
    const login = readFileSync("src/views/Login.vue", "utf8");
    expect(login).not.toMatch(/^import GoogleRecoveryPanel from/m);
    expect(login).toContain('defineAsyncComponent(() => import("@/components/GoogleRecoveryPanel.vue"))');
  });

  it("does not blur behind the opaque sticky new-messages pill", () => {
    const home = readFileSync("src/views/Home.vue", "utf8");
    const start = home.indexOf(".new-messages-notification {");
    const rule = home.slice(start, home.indexOf("}", start));
    expect(rule).not.toMatch(/^\s*(-webkit-)?backdrop-filter:/m);
  });
});
