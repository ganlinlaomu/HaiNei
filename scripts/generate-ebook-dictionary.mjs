/**
 * Build an offline 50k-word English–Chinese pack from ECDICT (MIT).
 *
 * Source is pinned to a source Git commit and Git blob SHA-1. Generation runs
 * at build time only; the dictionary is not part of the PWA entry bundle.
 *
 * Usage: node scripts/generate-ebook-dictionary.mjs
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const SOURCE_COMMIT = "ab22ad36302cafc6349a050e2b60894855208055";
const SOURCE_BLOB_SHA = "0e527e22e0e0d22f012b0ed251a8dddd5891773b";
const SOURCE_SIZE = 66_009_548;
const SOURCE_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/" + SOURCE_COMMIT + "/ecdict.csv";
const DEST = new URL("../public/ebook-dictionary/v1/", import.meta.url);
const TARGET_WORDS = 50_000;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const allowedWord = /^[a-z][a-z'-]{0,39}$/;

/** Streaming-safe CSV parser supporting double-quotes and embedded line breaks. */
export function parseCsv(text, onRow) {
  let fields = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      fields.push(field); field = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      fields.push(field); field = "";
      onRow(fields); fields = [];
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error("ECDICT CSV ended inside a quoted field");
  if (fields.length || field) { fields.push(field); onRow(fields); }
}

export function buildPack(csv, limit = TARGET_WORDS) {
  const candidates = new Map();
  let header = true;
  parseCsv(csv, (cells) => {
    if (header) {
      header = false;
      if (cells[0] !== "word" || cells[3] !== "translation" || cells[8] !== "bnc") {
        throw new Error("Unexpected ECDICT column order");
      }
      return;
    }
    if (cells.length < 11) return;
    const word = cells[0].trim().toLowerCase();
    if (!allowedWord.test(word)) return;
    const translation = cells[3].replace(/\\n/g, "；").replace(/\s+/g, " ").trim();
    if (!/[\u3400-\u9fff]/u.test(translation)) return;
    const bnc = Number(cells[8]) || 0, frq = Number(cells[9]) || 0;
    let priority = Math.min(bnc > 0 ? bnc : 1_000_000, frq > 0 ? frq : 1_000_000);
    if (cells[6] && cells[6] !== "0") priority = Math.min(priority, 8_000);
    if (/\b(?:gk|zk|cet4|cet6|ky|ielts|toefl)\b/.test(cells[7])) priority = Math.min(priority, 38_000);
    if (priority >= 250_000) return;
    const row = {
      word, phonetic: cells[1].trim().slice(0, 75),
      translation: translation.slice(0, 210),
      exchange: cells[10] || "", priority,
    };
    const previous = candidates.get(word);
    if (!previous || row.priority < previous.priority) candidates.set(word, row);
  });
  const ranked = [...candidates.values()].sort((a, b) =>
    a.priority - b.priority || a.word.localeCompare(b.word)).slice(0, limit);
  if (ranked.length < limit) throw new Error("ECDICT source has too few qualifying words: " + ranked.length);
  const buckets = Object.fromEntries([...LETTERS].map(letter => [letter, { words: {}, forms: {} }]));
  const selected = new Set(ranked.map(item => item.word));
  for (const row of ranked) {
    buckets[row.word[0]].words[row.word] = [row.phonetic, row.translation];
  }
  for (const row of ranked) {
    for (const part of row.exchange.split("/")) {
      const split = part.indexOf(":");
      if (split < 1 || !["p", "d", "i", "3", "s", "r", "t"].includes(part.slice(0, split))) continue;
      for (const form of part.slice(split + 1).split(",")) {
        const variant = form.trim().toLowerCase();
        if (allowedWord.test(variant) && !selected.has(variant) && !buckets[variant[0]].forms[variant]) {
          buckets[variant[0]].forms[variant] = row.word;
        }
      }
    }
  }
  return { buckets, count: ranked.length };
}

export async function generatePack() {
  let data;
  try {
    data = await readFile(join(new URL(".", import.meta.url).pathname, "ecdict-build-source.csv"));
  } catch {
    const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error("Cannot download pinned ECDICT source: " + response.status);
    data = Buffer.from(await response.arrayBuffer());
  }
  if (data.byteLength !== SOURCE_SIZE) throw new Error("ECDICT source size changed unexpectedly");
  const sha = createHash("sha1").update("blob " + data.byteLength + "\0").update(data).digest("hex");
  if (sha !== SOURCE_BLOB_SHA) throw new Error("ECDICT source content hash mismatch");
  const result = buildPack(data.toString("utf8"));
  await mkdir(DEST, { recursive: true });
  let totalBytes = 0;
  for (const letter of LETTERS) {
    const payload = JSON.stringify(result.buckets[letter]);
    totalBytes += Buffer.byteLength(payload);
    await writeFile(new URL(letter + ".json", DEST), payload);
  }
  const manifest = {
    version: "v1", count: result.count, files: [...LETTERS].map(c => c + ".json"),
    dataBytes: totalBytes, source: "ECDICT",
    sourceCommit: SOURCE_COMMIT, sourceBlobSha: SOURCE_BLOB_SHA,
    license: "MIT",
  };
  await writeFile(new URL("manifest.json", DEST), JSON.stringify(manifest));
  console.log("[ebook dictionary] generated", result.count, "entries,", totalBytes, "JSON bytes, 26 lookup shards");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  await generatePack();
}
