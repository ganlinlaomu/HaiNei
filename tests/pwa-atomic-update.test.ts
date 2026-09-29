import { readFileSync } from "node:fs";
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

  it("uses a temporary build query and removes it after verification", () => {
    const component = readFileSync(join(process.cwd(), "src/components/UpdateNotification.vue"), "utf8");
    expect(component).toContain('const BUILD_QUERY_KEY = "_hainei_build"');
    expect(component).toContain("url.searchParams.set(BUILD_QUERY_KEY, buildId)");
    expect(component).toContain("url.searchParams.delete(BUILD_QUERY_KEY)");
    expect(component).toContain("window.history.replaceState");
  });
});
