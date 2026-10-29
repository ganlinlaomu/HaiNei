// Drives the excerpt fixture with real touch input in Chromium.
// PLAYWRIGHT=<path to playwright-core> FIXTURE_URL=http://127.0.0.1:5180/tests/browser/ebook-excerpt-fixture.html
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright-core");
const url = process.env.FIXTURE_URL || "http://127.0.0.1:5180/tests/browser/ebook-excerpt-fixture.html";
const assert = (ok, message) => { if (!ok) throw new Error("FAIL: " + message); console.log("ok -", message); };

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const context = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", error => console.log("pageerror:", error.message));
await page.goto(url);
await page.waitForFunction(() => {
  const frame = document.querySelector(".chapter-frame");
  return frame?.contentDocument?.querySelectorAll("p").length === 12 && parseInt(frame.style.height) > 500;
}, null, { timeout: 30000 });
const cdp = await context.newCDPSession(page);
const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y]) => ({ x, y })) });
const pointOf = (index, fraction = 0.15) => page.evaluate(([i, f]) => {
  const frame = document.querySelector(".chapter-frame");
  const p = frame.contentDocument.querySelectorAll("p")[i];
  const range = frame.contentDocument.createRange();
  range.selectNodeContents(p);
  const first = range.getClientRects()[0], box = frame.getBoundingClientRect();
  return [box.left + first.left + first.width * f, box.top + first.top + first.height / 2];
}, [index, fraction]);
const state = () => page.evaluate(() => ({
  bar: !!document.querySelector(".excerpt-bar"),
  info: document.querySelector(".excerpt-bar-info span")?.textContent?.trim(),
  boxes: document.querySelectorAll(".excerpt-highlights span").length,
  dictionary: !!document.querySelector(".dictionary-card"),
  scrollTop: document.querySelector(".chapter-scroller").scrollTop,
}));

// 1. A long press selects the sentence under the finger.
const [x, y] = await pointOf(1, 0.1);
await touch("touchStart", [[x, y]]);
await page.waitForTimeout(650);
await touch("touchEnd", []);
await page.waitForTimeout(150);
let s = await state();
assert(s.bar && s.boxes > 0, `long press shows the excerpt bar and highlight (${s.info}, ${s.boxes} boxes)`);
assert(!s.dictionary, "long press does not also open the dictionary");

// 2. Grow by one sentence, then publish into the composer.
await page.getByRole("button", { name: "后一句 ›" }).click();
await page.getByRole("button", { name: "摘录", exact: true }).click();
const ui = await page.evaluate(() => ({ show: window.__ui.showPostEditor, prefill: window.__ui.postEditorPrefill }));
console.log("prefill:", JSON.stringify(ui.prefill));
assert(ui.show && ui.prefill.startsWith("「第2段：他说：「天亮了。」我们出发吧！」"), "摘录 opens the composer with the quoted sentences");
assert(ui.prefill.includes("—— 《边城》 · 沈从文 · 第一章"), "composer text names the book, author and chapter");
s = await state();
assert(!s.bar && s.boxes === 0, "the selection clears after publishing");

// 3. Long press then drag across paragraphs extends the selection without scrolling.
const before = (await state()).scrollTop;
const [sx, sy] = await pointOf(0, 0.1);
const [ex, ey] = await pointOf(3, 0.5);
await touch("touchStart", [[sx, sy]]);
await page.waitForTimeout(650);
for (let i = 1; i <= 8; i++) {
  await touch("touchMove", [[sx + (ex - sx) * i / 8, sy + (ey - sy) * i / 8]]);
  await page.waitForTimeout(30);
}
await touch("touchEnd", []);
await page.waitForTimeout(150);
s = await state();
const chars = Number(/已选 (\d+) 字/.exec(s.info || "")?.[1] || 0);
assert(s.bar && chars > 80, `dragging extends across paragraphs (${s.info})`);
assert(Math.abs(s.scrollTop - before) < 2, "the page did not scroll while selecting");

// 4. A tap clears the selection; a quick swipe scrolls instead of selecting.
await page.touchscreen.tap(sx, sy);
await page.waitForTimeout(150);
s = await state();
assert(!s.bar && s.boxes === 0, "a tap clears the selection");
await touch("touchStart", [[200, 500]]);
for (let i = 1; i <= 6; i++) { await touch("touchMove", [[200, 500 - i * 40]]); await page.waitForTimeout(16); }
await touch("touchEnd", []);
await page.waitForTimeout(700);
s = await state();
assert(!s.bar, "a swipe does not start a selection");

// 5. Tapping an English word still opens the dictionary.
const [wx, wy] = await page.evaluate(() => {
  const frame = document.querySelector(".chapter-frame");
  const p = frame.contentDocument.querySelectorAll("p")[5];
  const text = p.firstChild;
  const at = text.data.indexOf("universally") + 3;
  const range = frame.contentDocument.createRange();
  range.setStart(text, at); range.setEnd(text, at + 1);
  const r = range.getClientRects()[0], box = frame.getBoundingClientRect();
  return [box.left + r.left + r.width / 2, box.top + r.top + r.height / 2];
});
await page.touchscreen.tap(wx, wy);
await page.waitForTimeout(200);
const word = await page.evaluate(() => document.querySelector(".dictionary-card strong")?.textContent);
assert(word === "universally", `a tap on a word still looks it up (${word})`);

await browser.close();
console.log("all excerpt checks passed");
