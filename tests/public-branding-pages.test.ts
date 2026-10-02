import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("public branding and legal pages", () => {
  it("ships extensionless-ready static branding pages outside the hash router", () => {
    for (const file of ["public/about.html", "public/privacy.html", "public/terms.html"]) {
      const html = source(file);
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("Hainei");
      expect(html).toContain("kudos-zap-citrus@duck.com");
      expect(html).not.toContain("<script");
    }
  });

  it("describes Google recovery data use and limits", () => {
    const privacy = source("public/privacy.html");
    expect(privacy).toContain("https://www.googleapis.com/auth/drive.appdata");
    expect(privacy).toContain("appDataFolder");
    expect(privacy).toContain("does not access regular Google Drive files");
    expect(privacy).toContain("does not sell Google user data");
    expect(privacy).toContain("does not persist these tokens");
  });

  it("links the public pages from the unauthenticated login surface", () => {
    const login = source("src/views/Login.vue");
    expect(login).toContain('href="/about"');
    expect(login).toContain('href="/privacy"');
    expect(login).toContain('href="/terms"');
  });
});
