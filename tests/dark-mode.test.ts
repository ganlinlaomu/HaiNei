import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@/services/deviceStorage", () => ({
  deviceStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
}));

import { initTheme, resolvedTheme, setThemePreference, themePreference } from "@/services/theme";

const tokensCss = readFileSync("src/theme-tokens.css", "utf8");
function block(start: string) {
  const at = tokensCss.indexOf(start);
  return Object.fromEntries([...tokensCss.slice(at, tokensCss.indexOf("}", at)).matchAll(/(--[a-z]+-[a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}
const light = block(":root {");
const dark = block(':root[data-theme="dark"] {');
const systemDark = block(':root:not([data-theme="light"]) {');

function sources(dir = "src"): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(vue|css)$/.test(name) ? [path] : [];
  });
}

describe("dark mode color tokens", () => {
  it("defines every token used in the app for light and both dark selectors", () => {
    const used = new Set(sources().flatMap(file => [...readFileSync(file, "utf8").matchAll(/var\((--(?:fg|bg|bd)-[a-z0-9-]+)\)/g)].map(m => m[1])));
    expect(used.size).toBeGreaterThan(50);
    for (const name of used) {
      expect(light[name], name).toBeTruthy();
      expect(dark[name], name).toBeTruthy();
      expect(systemDark[name], name).toBe(dark[name]);
    }
  });

  it("keeps every light value equal to the original color in its name (light mode unchanged)", () => {
    for (const [name, value] of Object.entries(light)) {
      const encoded = name.replace(/^--(?:fg|bg|bd)-/, "");
      expect(value.replace(/^#/, "").replace(/[^0-9a-z]+/g, "-").replace(/^-|-$/g, ""), name).toBe(encoded);
    }
  });

  it("leaves already-dark and must-stay-light UI untouched", () => {
    for (const file of ["src/views/Login.vue", "src/components/GoogleRecoveryPanel.vue", "src/components/ImageViewer.vue", "src/components/VideoPlayer.vue", "src/components/EncryptedVideoPlayer.vue"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/var\(--(?:fg|bg|bd)-/);
    }
    const qr = readFileSync("src/components/MyQrCodeSheet.vue", "utf8");
    const card = qr.slice(qr.indexOf(".qr-card"), qr.indexOf("}", qr.indexOf(".qr-card")));
    expect(card).not.toMatch(/var\(--(?:fg|bg|bd)-/);
  });

  it("loads the tokens and switches global colors and native controls", () => {
    expect(readFileSync("src/main.ts", "utf8")).toContain('import "./theme-tokens.css";');
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toContain(':root[data-theme="dark"]');
    expect(styles).toContain(':root:not([data-theme="light"])');
    expect(styles.match(/color-scheme: dark;/g)?.length).toBe(2);
  });
});

function fakeDom(systemDark: boolean) {
  const attrs = new Map<string, string>();
  const meta = new Map<string, string>([["content", "#0f172a"]]);
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
      getAttribute: (k: string) => attrs.get(k) ?? null,
      hasAttribute: (k: string) => attrs.has(k),
    },
    querySelector: () => ({ setAttribute: (k: string, v: string) => meta.set(k, v), getAttribute: (k: string) => meta.get(k) ?? null }),
  });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: systemDark, addEventListener: () => {} }) });
  return { attrs, meta };
}

describe("theme preference", () => {
  beforeEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });

  it("defaults to following the system without forcing an attribute", () => {
    const dom = fakeDom(false);
    initTheme();
    expect(themePreference.value).toBe("system");
    expect(dom.attrs.has("data-theme")).toBe(false);
    expect(resolvedTheme()).toBe("light");
    expect(dom.meta.get("content")).toBe("#0f172a");
  });

  it("applies and persists an explicit choice, and clears it for system", () => {
    const dom = fakeDom(false);
    setThemePreference("dark");
    expect(dom.attrs.get("data-theme")).toBe("dark");
    expect(dom.meta.get("content")).toBe("#0e0f12");
    expect(storage.get("hainei_theme")).toBe("dark");

    themePreference.value = "system";
    initTheme(); // next cold start
    expect(themePreference.value).toBe("dark");

    setThemePreference("system");
    expect(dom.attrs.has("data-theme")).toBe(false);
    expect(storage.has("hainei_theme")).toBe(false);
    expect(dom.meta.get("content")).toBe("#0f172a");
  });

  it("follows a dark system setting when no choice is stored", () => {
    const dom = fakeDom(true);
    initTheme();
    expect(resolvedTheme()).toBe("dark");
    expect(dom.attrs.has("data-theme")).toBe(false);
    expect(dom.meta.get("content")).toBe("#0e0f12");
  });
});
