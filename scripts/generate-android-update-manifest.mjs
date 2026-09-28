#!/usr/bin/env node
import fs from "node:fs";

const [outputPath, versionCodeRaw, versionName, sha256, commit, ...notesParts] = process.argv.slice(2);
const versionCode = Number(versionCodeRaw);
const notes = notesParts.join(" ").trim() || `HaiNei ${versionName}`;

if (!outputPath || !Number.isInteger(versionCode) || versionCode <= 0 || !versionName) {
  throw new Error("usage: generate-android-update-manifest.mjs <output> <versionCode> <versionName> <sha256> <commit> [notes]");
}
if (!/^[a-f0-9]{64}$/i.test(sha256 || "")) throw new Error("invalid sha256");

const manifest = {
  versionCode,
  versionName,
  apkUrl: "https://github.com/ganlinlaomu/HaiNei/releases/download/android-latest/HaiNei.apk",
  sha256: sha256.toLowerCase(),
  notes,
  publishedAt: new Date().toISOString(),
  commit: commit || "",
};

fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote Android update manifest for ${versionName} (${versionCode})`);
