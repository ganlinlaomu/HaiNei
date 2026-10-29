/**
 * Generate an Aozora Bunko search index at BUILD time, not inside a
 * Cloudflare Pages request. Official metadata © Aozora Bunko contributors,
 * CC BY 4.0. Individual works retain their own rights.
 */
import { inflateRawSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

const SOURCE = "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip";
const DEST = new URL("../public/ebook-catalog/aozora-index-v1.json", import.meta.url);
const MAX_ZIP = 16 * 1024 * 1024;
const MAX_CSV = 64 * 1024 * 1024;
const HTML_PATH = /^\/cards\/\d{6}\/files\/\d+_[\w-]+\.html$/;
const CARD_PATH = /^\/cards\/\d{6}\/card\d+\.html$/;

function u16(bytes, offset) { return bytes.readUInt16LE(offset); }
function u32(bytes, offset) { return bytes.readUInt32LE(offset); }

export function unzipAozoraCsv(bytes) {
  if (bytes.length < 22 || bytes.length > MAX_ZIP) throw Error("Aozora ZIP exceeds limit or is empty");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw Error("Invalid Aozora ZIP directory");
  const count = u16(bytes, end + 10);
  if (count === 0 || count > 20) throw Error("Unexpected Aozora ZIP entry count");
  let cursor = u32(bytes, end + 16);
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || u32(bytes, cursor) !== 0x02014b50) throw Error("Corrupt ZIP directory");
    const method = u16(bytes, cursor + 10);
    const compressed = u32(bytes, cursor + 20);
    const uncompressed = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const local = u32(bytes, cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!name.toLowerCase().endsWith(".csv")) continue;
    if (compressed > MAX_ZIP || uncompressed > MAX_CSV ||
        local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) {
      throw Error("Invalid Aozora CSV archive entry");
    }
    const dataStart = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    if (dataStart + compressed > bytes.length) throw Error("Truncated Aozora CSV ZIP");
    const data = bytes.subarray(dataStart, dataStart + compressed);
    const csv = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_CSV }) : null;
    if (!csv || csv.length !== uncompressed) throw Error("Unsupported or corrupt Aozora ZIP compression");
    return csv.toString("utf8");
  }
  throw Error("Aozora CSV not found in ZIP");
}

export function rowsFromAozoraCsv(csv) {
  const works = new Map();
  let fields = [], field = "", quoted = false, columns = null;
  function row() {
    if (!columns) {
      columns = Object.fromEntries(fields.map((name, index) => [name.replace(/^\uFEFF/, ""), index]));
      if (["作品ID", "作品名", "作品著作権フラグ", "人物著作権フラグ", "役割フラグ",
           "XHTML/HTMLファイルURL", "図書カードURL"].some(name => columns[name] === undefined)) {
        throw Error("Aozora CSV headers changed");
      }
      return;
    }
    const get = name => fields[columns[name]] || "";
    if (get("作品著作権フラグ") !== "なし" || get("人物著作権フラグ") !== "なし" ||
        get("役割フラグ") !== "著者") return;
    const id = Number(get("作品ID"));
    if (!Number.isSafeInteger(id) || id < 1 || id > 999999 || works.has(id)) return;
    let source, card;
    try {
      source = new URL(get("XHTML/HTMLファイルURL").replace(/^http:/, "https:"));
      card = new URL(get("図書カードURL").replace(/^http:/, "https:"));
    } catch { return; }
    if (source.protocol !== "https:" || source.hostname !== "www.aozora.gr.jp" ||
        !HTML_PATH.test(source.pathname) || source.search || source.hash ||
        card.protocol !== "https:" || card.hostname !== "www.aozora.gr.jp" ||
        !CARD_PATH.test(card.pathname) || card.search || card.hash) return;
    // Aozorahack expands the official text ZIP using its ZIP stem. Preserve
    // this optional, validated fallback beside the official XHTML URL.
    let textUrl;
    try {
      const textZip = new URL(get("テキストファイルURL").replace(/^http:/, "https:"));
      const match = /^\/cards\/(\d{6})\/files\/(\d+_[\w-]+)\.zip$/.exec(textZip.pathname);
      if (textZip.protocol === "https:" && textZip.hostname === "www.aozora.gr.jp" &&
          !textZip.port && !textZip.username && !textZip.password &&
          !textZip.search && !textZip.hash && match &&
          match[1] === source.pathname.split("/")[2] &&
          match[2].startsWith(String(id) + "_")) {
        textUrl = "https://raw.githubusercontent.com/aozorahack/aozorabunko_text/master/cards/" + match[1] +
          "/files/" + match[2] + "/" + match[2] + ".txt";
      }
    } catch { /* Some works do not have a downloadable text ZIP. */ }
    const title = get("作品名").trim(), author = get("姓名").trim() ||
      [get("姓"), get("名")].filter(Boolean).join(" ");
    if (title && author) works.set(id, {
      id: "aozora:" + id, title: title.slice(0, 180), authors: [author.slice(0, 100)],
      language: "ja", epubUrl: source.origin + source.pathname,
      sourceUrl: card.origin + card.pathname, ...(textUrl ? { textUrl } : {}), downloads: 0,
    });
  }
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      fields.push(field); field = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      fields.push(field); field = ""; row(); fields = [];
    } else {
      field += ch;
    }
  }
  if (quoted) throw Error("Aozora CSV has unmatched quote");
  if (fields.length || field) { fields.push(field); row(); }
  return [...works.values()];
}

export async function generateAozoraCatalog() {
  const response = await fetch(SOURCE, {
    headers: { "User-Agent": "HaiNei-BookReader/1.0 (https://github.com/ganlinlaomu/HaiNei)" },
    signal: AbortSignal.timeout(75_000),
  });
  if (!response.ok) throw Error("Aozora official catalogue HTTP " + response.status);
  const length = Number(response.headers.get("Content-Length") || 0);
  if (length > MAX_ZIP) throw Error("Aozora catalogue ZIP too large");
  const bytes = Buffer.from(await response.arrayBuffer());
  const rows = rowsFromAozoraCsv(unzipAozoraCsv(bytes));
  if (rows.length < 1000 || rows.length > 30000) throw Error("Unexpected public Aozora work count: " + rows.length);
  await mkdir(new URL(".", DEST), { recursive: true });
  const json = JSON.stringify({ version: 1, source: "Aozora Bunko", license: "CC BY 4.0", books: rows });
  await writeFile(DEST, json);
  console.log("[aozora catalog] compiled", rows.length, "books, index bytes", Buffer.byteLength(json));
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  await generateAozoraCatalog();
}
