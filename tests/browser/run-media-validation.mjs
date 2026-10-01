import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = process.env.CHROME;
const url = process.env.MEDIA_VALIDATION_URL || "http://127.0.0.1:5173/tests/browser/media-validation.html";
if (!chrome) throw new Error("CHROME environment variable is required");
if (typeof WebSocket !== "function") throw new Error("This Node runtime does not expose WebSocket");

const profile = join(tmpdir(), `hainei-chrome-${process.pid}`);
mkdirSync(profile, { recursive: true });

const child = spawn(chrome, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-background-timer-throttling",
  "--autoplay-policy=no-user-gesture-required",
  "--remote-debugging-port=9222",
  `--user-data-dir=${profile}`,
  url,
], { stdio: ["ignore", "ignore", "inherit"] });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function targetInfo() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:9222/json");
      const targets = await response.json();
      const target = targets.find(item => item.type === "page" && item.url.includes("media-validation.html"));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await sleep(100);
  }
  throw new Error("Chrome DevTools target did not become available");
}

async function evaluate(ws, expression, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP evaluate timed out")), 5_000);
    const listener = event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", listener);
      if (message.error) reject(new Error(message.error.message || "CDP evaluate failed"));
      else resolve(message.result?.result?.value);
    };
    ws.addEventListener("message", listener);
    ws.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    }));
  });
}

let ws;
try {
  const target = await targetInfo();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP WebSocket connection timed out")), 5_000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket failed")); }, { once: true });
  });

  for (let attempt = 1; attempt <= 120; attempt += 1) {
    const text = await evaluate(
      ws,
      "document.querySelector('#result')?.textContent || ''",
      attempt,
    );
    if (typeof text === "string" && text.startsWith("PASS:")) {
      console.log(text);
      process.exitCode = 0;
      break;
    }
    if (typeof text === "string" && text.startsWith("FAIL:")) {
      throw new Error(text);
    }
    if (attempt === 120) throw new Error(`Browser validation did not finish; last result: ${text}`);
    await sleep(100);
  }
} finally {
  try { ws?.close(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    sleep(500),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      sleep(500),
    ]);
  }
  let cleanupError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true });
      cleanupError = undefined;
      break;
    } catch (error) {
      cleanupError = error;
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error?.code)) throw error;
      await sleep(200);
    }
  }
  if (cleanupError) {
    console.warn(`Browser validation passed but Chrome profile cleanup was incomplete: ${cleanupError.code}`);
  }
}
