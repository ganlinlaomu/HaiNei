#!/usr/bin/env node

/**
 * Trystero 0.26.0 starts Nostr subscriptions at the browser's exact local
 * second. If one device's clock is ahead, the relay correctly filters live
 * announcements from a slower device and the peers never discover each
 * other. Keep a short overlap until this is fixed upstream.
 */

const fs = require("fs");
const path = require("path");

const nostrPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "@trystero-p2p",
  "nostr",
  "dist",
  "index.mjs",
);
const lookbackDeclaration = "const subscriptionLookbackSec = 60;";

let source = fs.readFileSync(nostrPath, "utf8");
if (source.includes(lookbackDeclaration)) {
  console.log("Trystero Nostr clock-skew patch already applied");
  process.exit(0);
}

const replacements = [
  [
    "const now = () => Math.floor(Date.now() / 1e3);",
    `const now = () => Math.floor(Date.now() / 1e3);\n${lookbackDeclaration}`,
  ],
  ["since: now(),", "since: now() - subscriptionLookbackSec,"],
  ["const since = now();", "const since = now() - subscriptionLookbackSec;"],
];

for (const [before, after] of replacements) {
  if (!source.includes(before)) {
    throw new Error(`Trystero Nostr patch target changed: ${before}`);
  }
  source = source.replace(before, after);
}

fs.writeFileSync(nostrPath, source);
console.log("Applied Trystero Nostr 60-second subscription lookback");
