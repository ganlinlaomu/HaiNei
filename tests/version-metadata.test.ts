import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("release version metadata", () => {
  it("keeps package version, runtime version, update summary and settings footer in sync", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      version?: string;
      releaseSummary?: string;
    };
    const dexie = readFileSync("src/db/dexie.ts", "utf8");
    const release = readFileSync("src/appRelease.ts", "utf8");
    const settings = readFileSync("src/views/SystemSettings.vue", "utf8");
    const changelog = readFileSync("CHANGELOG.md", "utf8");

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.releaseSummary?.trim().length).toBeGreaterThan(0);
    expect(dexie).toContain(`export const APP_VERSION = "${pkg.version}";`);
    expect(release).toContain(`export const APP_UPDATE_SUMMARY = ${JSON.stringify(pkg.releaseSummary)};`);
    expect(changelog).toContain(`## ${pkg.version} —`);
    expect(settings).toContain("HaiNei v{{ APP_VERSION }} · {{ APP_UPDATE_SUMMARY }}");
  });
});
