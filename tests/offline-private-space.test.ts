// 私人空间 could not open offline: lazily loaded chunks were only cached
// after an online visit, and views could render before the session restore
// had unlocked the local vault.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { injectPrecacheList, PRECACHE_MARKER, precacheAssetList } from "../build-plugins/swPrecache";

describe("service worker precache", () => {
  it("lists every emitted JS/CSS chunk once, without source maps or other files", () => {
    expect(precacheAssetList([
      "assets/PrivateSpace-1.js", "assets/PrivateSpace-1.css", "assets/index-2.js",
      "assets/index-2.js", "assets/index-2.js.map", "index.html", "assets/logo.png",
    ])).toEqual(["/assets/PrivateSpace-1.css", "/assets/PrivateSpace-1.js", "/assets/index-2.js"]);
  });

  it("injects the list into the shipped service worker and installs it tolerantly", () => {
    const sw = readFileSync("public/service-worker.js", "utf8");
    expect(sw).toContain(PRECACHE_MARKER);
    const built = injectPrecacheList(sw, ["/assets/a.js"]);
    expect(built).toContain('const PRECACHE_ASSETS = ["/assets/a.js"];');
    // One failing chunk must not abort the install.
    expect(sw).toContain("Promise.allSettled(PRECACHE_ASSETS.map(precache))");
    expect(sw).toContain("return cache.add(url);");
    expect(() => injectPrecacheList("no marker", [])).toThrow();
    expect(readFileSync("vite.config.ts", "utf8")).toContain("swPrecachePlugin()");
  });
});

describe("views wait for the unlocked session", () => {
  it("router waits for session restore to finish, not just for pkHex", () => {
    const router = readFileSync("src/router/index.ts", "utf8");
    expect(router).toContain("if (!keyStore.isRestored) {");
    expect(router).not.toContain("if (!keyStore.pkHex && !keyStore.loginMethod) {");
  });

  it("私人空间 loads only once the account's local stores are ready", () => {
    const view = readFileSync("src/views/PrivateSpace.vue", "utf8");
    expect(view).toContain("watch(() => [keys.pkHex, keys.isUnlocked, keys.accountStoresReadyFor] as const");
    expect(view).toContain("if (unlocked && account && readyFor !== account) {");
  });
});
