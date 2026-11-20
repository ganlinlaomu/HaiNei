import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("system settings sections", () => {
  it("connection and privacy start collapsed like the other sections", () => {
    for (const file of ["ConnectionSection", "PrivacySection"]) {
      const source = readFileSync(`src/views/settings/${file}.vue`, "utf8");
      expect(source).toContain('<details class="technical-section">');
      expect(source).not.toMatch(/<details class="technical-section"[^>]*\bopen\b/);
    }
  });
});
