import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("atomic PWA update handoff", () => {
  it("exposes the service worker build identity", () => {
    const sw = readFileSync(join(process.cwd(), "public/service-worker.js"), "utf8");
    expect(sw).toContain("GET_BUILD_INFO");
    expect(sw).toContain("BUILD_INFO");
    expect(sw).toContain("buildId: BUILD_ID");
    expect(sw).toContain("event.waitUntil(self.skipWaiting())");
  });

  it("verifies the target build before reloading into it", () => {
    const component = readFileSync(join(process.cwd(), "src/components/UpdateNotification.vue"), "utf8");
    expect(component).toContain("requestBuildInfo");
    expect(component).toContain("waitForControllerBuild");
    expect(component).toContain('sessionStorage.setItem(PENDING_BUILD_KEY, expectedBuildId)');
    expect(component).toContain("info?.buildId === buildId");
    expect(component).toContain("reloadForBuild(targetBuildId)");
    expect(component).toContain("verifyReloadedBuild");
  });

  it("requires a genuinely different waiting build and watches SW updates once", () => {
    const source = readFileSync(join(process.cwd(), "src/components/UpdateNotification.vue"), "utf8");
    expect(source).toContain("const sameBuild =");
    expect(source).toContain("next.buildId === current.buildId");
    expect(source).toContain("const alreadyApplying =");
    expect(source).toContain("showUpdate.value = !sameBuild && !alreadyApplying");
    expect(source).toContain("registration.addEventListener('updatefound', handleUpdateFound)");
    expect(source).not.toContain("registration.onupdatefound =");
    expect(source).toContain("if (updating.value) return");
    expect(source).not.toContain("showUpdate.value = true;");
  });

  it("keeps build IDs stable across same-code redeploys but changes on source edits", () => {
    const root = mkdtempSync(join(tmpdir(), "hainei-sw-id-"));
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "public"));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
      writeFileSync(join(root, "src", "app.ts"), "export const msg = 'hello';");
      writeFileSync(join(root, "public", "service-worker.js"),
        'const VERSION = "old";\\nconst BUILD_ID = "old";\\n');
      writeFileSync(join(root, "scripts", "update-sw-version.js"),
        readFileSync(join(process.cwd(), "scripts/update-sw-version.js")));
      const env = { ...process.env, CF_PAGES_COMMIT_SHA: "abc123", GITHUB_SHA: "", COMMIT_SHA: "" };
      const rebuild = () => {
        execFileSync(process.execPath, [join(root, "scripts", "update-sw-version.js")], { cwd: root, env });
        const text = readFileSync(join(root, "public", "service-worker.js"), "utf8");
        return /const BUILD_ID = "([^"]+)"/.exec(text)?.[1];
      };
      const first = rebuild();
      expect(first).toBeTruthy();
      expect(rebuild()).toBe(first);
      writeFileSync(join(root, "src", "app.ts"), "export const msg = 'changed';");
      expect(rebuild()).not.toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a temporary build query and removes it after verification", () => {
    const component = readFileSync(join(process.cwd(), "src/components/UpdateNotification.vue"), "utf8");
    expect(component).toContain('const BUILD_QUERY_KEY = "_hainei_build"');
    expect(component).toContain("url.searchParams.set(BUILD_QUERY_KEY, buildId)");
    expect(component).toContain("url.searchParams.delete(BUILD_QUERY_KEY)");
    expect(component).toContain("window.history.replaceState");
  });
});
