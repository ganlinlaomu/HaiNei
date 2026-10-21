// Renders iOS PWA launch images (apple-touch-startup-image). Without them iOS
// shows a plain white screen while it cold-starts the PWA, e.g. from a push
// notification. They mirror the in-page boot splash in index.html.
// Usage: CHROME=/path/to/chrome-headless-shell node scripts/generate-ios-splash.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CSS portrait size and device pixel ratio of each iPhone screen class.
export const IOS_SCREENS = [
  [440, 956, 3], [430, 932, 3], [428, 926, 3], [420, 912, 3], [414, 896, 3], [414, 896, 2],
  [414, 736, 3], [402, 874, 3], [393, 852, 3], [390, 844, 3], [375, 812, 3], [375, 667, 2],
];
export const THEMES = {
  light: { background: "#f7fafc", color: "#94a3b8" },
  dark: { background: "#0e0f12", color: "#475569" },
};
export const splashFile = (width, height, ratio, theme) => `splash/${theme}-${width * ratio}x${height * ratio}.png`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const chrome = process.env.CHROME;
  if (!chrome) throw new Error("Set CHROME to a headless Chromium binary");
  const work = mkdtempSync(join(tmpdir(), "hainei-splash-"));
  for (const [theme, { background, color }] of Object.entries(THEMES)) {
    const page = join(work, `${theme}.html`);
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${background}}
body{display:grid;place-items:center;color:${color};font:600 28px/1 "PingFang SC","Noto Sans SC","WenQuanYi Zen Hei",sans-serif;letter-spacing:.2em}
</style><body>海内</body>`);
    for (const [width, height, ratio] of IOS_SCREENS) {
      execFileSync(chrome, [
        "--headless", "--hide-scrollbars", "--no-sandbox",
        `--window-size=${width},${height}`, `--force-device-scale-factor=${ratio}`,
        `--screenshot=${join(process.cwd(), "public", splashFile(width, height, ratio, theme))}`,
        `file://${page}`,
      ], { stdio: "ignore" });
    }
  }
}
