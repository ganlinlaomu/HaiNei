// From a push notification iOS cold-starts the PWA and showed a plain white
// screen until the page loaded; launch images replace that with the splash.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped build script
import { IOS_SCREENS, THEMES, splashFile } from "../scripts/generate-ios-splash.mjs";

const html = readFileSync("index.html", "utf8");

function pngSize(path: string) {
  const bytes = readFileSync(path);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("iOS launch images", () => {
  it("links a light and dark image for every iPhone screen class, at its pixel size", () => {
    const links = [...html.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="\/([^"]+)"/g)];
    expect(links).toHaveLength(IOS_SCREENS.length * Object.keys(THEMES).length);
    for (const theme of Object.keys(THEMES)) {
      for (const [width, height, ratio] of IOS_SCREENS as number[][]) {
        const file = splashFile(width, height, ratio, theme);
        const link = links.find(match => match[2] === file);
        expect(link?.[1]).toBe(`(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait) and (prefers-color-scheme: ${theme})`);
        expect(pngSize(`public/${file}`)).toEqual([width * ratio, height * ratio]);
      }
    }
  });

  it("matches the in-page boot splash background", () => {
    expect(html).toContain(`background: ${THEMES.light.background};`);
    expect(html).toContain(`background: ${THEMES.dark.background};`);
    expect(JSON.parse(readFileSync("public/manifest.json", "utf8")).background_color).toBe(THEMES.light.background);
  });
});
