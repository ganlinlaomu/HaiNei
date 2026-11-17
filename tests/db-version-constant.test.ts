import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DB_VERSION } from "@/db/dexie";

it("DB_VERSION (shown in the debug export) matches the newest schema version", () => {
  const source = readFileSync("src/db/dexie.ts", "utf8");
  const versions = [...source.matchAll(/this\.version\((\d+)\)/g)].map(match => Number(match[1]));
  expect(DB_VERSION).toBe(Math.max(...versions));
});
