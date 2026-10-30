import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("release version alignment", () => {
  it("keeps app, lockfile, Dexie, service worker, and changelog in sync", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string; releaseSummary: string };
    const lock = JSON.parse(read("package-lock.json")) as {
      version: string;
      packages: { "": { version: string } };
    };
    const appVersion = read("src/db/dexie.ts").match(/export const APP_VERSION = "([^"]+)"/)?.[1];
    const swVersion = read("public/service-worker.js").match(/const VERSION = "([^"]+)"/)?.[1];
    const changelogVersion = read("CHANGELOG.md").match(/^## (\d+\.\d+\.\d+) — /)?.[1];

    expect(pkg.version).toBe("0.1.186");
    expect([lock.version, lock.packages[""].version, appVersion, swVersion, changelogVersion])
      .toEqual(Array(5).fill(pkg.version));
    expect(read("src/appRelease.ts")).toContain(
      `export const APP_UPDATE_SUMMARY = ${JSON.stringify(pkg.releaseSummary)};`,
    );
  });
});
