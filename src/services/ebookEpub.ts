/**
 * Minimal offline EPUB (ZIP/OPF/XHTML) renderer, using the browser's native
 * deflate-raw decoder. Does not execute publisher-provided JavaScript or CSS.
 * Handles standard non-DRM EPUB2/3; encrypted and ZIP64 books are rejected.
 */
const MAX_ENTRIES = 3000;
const MAX_PART = 12 * 1024 * 1024;
const MAX_UNPACKED = 120 * 1024 * 1024;

type ZipEntry = { offset: number; compressed: number; unpacked: number; method: number };
type SpineEntry = { path: string; title: string };

function pathFrom(base: string, relative: string): string {
  const joined = relative.startsWith("/") ? relative.slice(1) : base.slice(0, base.lastIndexOf("/") + 1) + relative;
  const pieces: string[] = [];
  for (const raw of joined.split("/")) {
    const part = decodeURIComponent(raw);
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!pieces.length) throw new Error("EPUB 路径超出书籍范围");
      pieces.pop();
      continue;
    }
    pieces.push(part);
  }
  return pieces.join("/");
}

class ZipArchive {
  private view: DataView;
  private bytes: Uint8Array;
  private entries = new Map<string, ZipEntry>();
  constructor(buffer: ArrayBuffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    const length = buffer.byteLength;
    let end = -1;
    for (let p = length - 22; p >= Math.max(0, length - 65557); p--) {
      if (this.u32(p) === 0x06054b50) { end = p; break; }
    }
    if (end < 0) throw new Error("文件不是有效的 EPUB 压缩包");
    const count = this.u16(end + 10);
    if (!count || count > MAX_ENTRIES || this.u16(end + 8) !== count) throw new Error("EPUB 文件目录不受支持");
    let cursor = this.u32(end + 16);
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > length || this.u32(cursor) !== 0x02014b50) throw new Error("EPUB 文件目录损坏");
      const flags = this.u16(cursor + 8);
      const method = this.u16(cursor + 10);
      const compressed = this.u32(cursor + 20);
      const unpacked = this.u32(cursor + 24);
      const nameLen = this.u16(cursor + 28);
      const extraLen = this.u16(cursor + 30);
      const commentLen = this.u16(cursor + 32);
      const offset = this.u32(cursor + 42);
      if (flags & 1 || (method !== 0 && method !== 8) ||
        compressed === 0xffffffff || unpacked === 0xffffffff ||
        unpacked > MAX_PART || (total += unpacked) > MAX_UNPACKED ||
        cursor + 46 + nameLen + extraLen + commentLen > length) {
        throw new Error("EPUB 包含不支持或过大的压缩内容");
      }
      const name = new TextDecoder().decode(this.bytes.subarray(cursor + 46, cursor + 46 + nameLen));
      if (name && !name.startsWith("/") && !name.includes("\0")) this.entries.set(name, { offset, compressed, unpacked, method });
      cursor += 46 + nameLen + extraLen + commentLen;
    }
  }
  private u16(p: number) { return this.view.getUint16(p, true); }
  private u32(p: number) { return this.view.getUint32(p, true); }
  async read(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error("缺少 EPUB 文件：" + name);
    const start = entry.offset;
    if (start + 30 > this.bytes.length || this.u32(start) !== 0x04034b50) throw new Error("EPUB 压缩内容损坏");
    const first = start + 30 + this.u16(start + 26) + this.u16(start + 28);
    if (first + entry.compressed > this.bytes.length) throw new Error("EPUB 压缩内容不完整");
    const compressed = this.bytes.slice(first, first + entry.compressed);
    let data: Uint8Array;
    if (entry.method === 0) data = compressed;
    else {
      if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持离线 EPUB 解压");
      const output = await new Response(
        new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
      ).arrayBuffer();
      data = new Uint8Array(output);
    }
    if (data.byteLength !== entry.unpacked || data.byteLength > MAX_PART) throw new Error("EPUB 压缩内容校验失败");
    return data;
  }
  async text(name: string) { return new TextDecoder("utf-8").decode(await this.read(name)); }
}

function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("EPUB 元数据损坏");
  return doc;
}

function elements(parent: ParentNode, localName: string): Element[] {
  return Array.from(parent.querySelectorAll("*")).filter(element => element.localName === localName);
}

/** Site furniture that EPUB exporters copy into every chapter. */
const SITE_CHROME = [
  // Wikisource (WS Export): edition notes, navigation, maintenance notices, licence banners, page numbers.
  ".hatnote", ".noprint", ".ws-noexport", ".mw-editsection", ".messagebox", ".licenseContainer", ".ws-pagenum", ".pagenum",
  // Project Gutenberg licence header and footer.
  "#pg-header", "#pg-footer", ".pg-boilerplate",
].join(",");
// "上一回　回目录　下一回" style navigation left as plain text.
const TEXT_NAVIGATION = /^(?:上一[回章卷篇頁页節节]|下一[回章卷篇頁页節节]|返回目[录錄]|回?目[录錄]|[←→|｜]|\s)+$/;

/** Remove exporter chrome so a chapter starts with its own text. */
export function stripSiteChrome(body: HTMLElement): void {
  for (const element of Array.from(body.querySelectorAll(SITE_CHROME))) element.remove();
  // The Wikisource header: a ← previous | title / author | next → table, then
  // an optional note about the work. Drop the navigation, keep the note as a quote.
  for (const header of Array.from(body.querySelectorAll("#headerContainer"))) {
    for (const table of Array.from(header.querySelectorAll("table"))) {
      if (/[←→]/.test(table.textContent || "")) { table.remove(); continue; }
      const note = body.ownerDocument.createElement("blockquote");
      for (const cell of Array.from(table.querySelectorAll("td,th"))) note.append(...Array.from(cell.childNodes));
      if (note.textContent?.trim()) table.replaceWith(note); else table.remove();
    }
  }
  for (const element of Array.from(body.querySelectorAll("p,div,center,td,span"))) {
    const text = (element.textContent || "").replace(/\s+/g, "");
    if (text && text.length <= 24 && TEXT_NAVIGATION.test(text)) element.remove();
  }
}

export type ChapterScript = "cjk" | "japanese" | "latin";

/** The script that dominates a chapter, for fonts and paragraph indents. */
export function chapterScript(text: string): ChapterScript {
  const sample = text.replace(/\s+/g, "").slice(0, 3000);
  if (!sample) return "latin";
  const han = (sample.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const kana = (sample.match(/[\u3040-\u30ff]/g) || []).length;
  if ((han + kana) / sample.length < 0.3) return "latin";
  return kana > sample.length * 0.05 ? "japanese" : "cjk";
}

const THEMES = {
  light: { bg: "#ffffff", fg: "#2b2f36", muted: "#6b7280", rule: "#e5e7eb", quote: "#f6f7f9", accent: "#c9a96b" },
  sepia: { bg: "#f5edda", fg: "#3d3528", muted: "#7c6f5b", rule: "#e2d5b8", quote: "#efe4cb", accent: "#b08a4e" },
  dark: { bg: "#20252b", fg: "#dfe3e8", muted: "#9aa3ad", rule: "#363d46", quote: "#272d34", accent: "#8f7a52" },
} as const;

/** Reading CSS for a chapter: comfortable measure, CJK indents, quiet notes. */
export function chapterStyles(theme: "light" | "sepia" | "dark", fontSize: number, script: ChapterScript, indented: boolean): string {
  const c = THEMES[theme] || THEMES.light;
  const font = script === "latin"
    ? '"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Noto Serif",serif'
    : script === "japanese"
      ? '"Hiragino Mincho ProN","Yu Mincho","Noto Serif CJK JP","Source Han Serif JP",serif'
      : '-apple-system,"PingFang SC","PingFang TC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif';
  const size = Math.max(14, Math.min(28, fontSize));
  const cjk = script !== "latin";
  return "html{background:" + c.bg + ";color:" + c.fg + ";font-family:" + font + ";font-size:" + size + "px;" +
    "line-height:" + (cjk ? "1.95" : "1.7") + ";overflow-wrap:anywhere;-webkit-text-size-adjust:100%;text-rendering:optimizeLegibility;font-kerning:normal}" +
    "body{margin:0 auto;max-width:" + (cjk ? "34em" : "36em") + ";padding:30px 24px 96px}" +
    // Justify CJK only: without a hyphenation dictionary, justified Latin text
    // on a phone-width column opens wide gaps between words.
    "p{margin:0 0 " + (cjk ? ".7em" : ".9em") + (cjk ? ";text-align:justify;letter-spacing:.02em" : ";text-align:left;hyphens:auto;-webkit-hyphens:auto") + "}" +
    (indented ? "p{text-indent:2em}" : "") +
    "h1,h2,h3,h4,h5,h6{text-indent:0;text-align:center;line-height:1.45;font-weight:600;letter-spacing:" + (cjk ? ".08em" : ".01em") + "}" +
    "h1{font-size:1.5em;margin:.6em 0 1.6em}h2{font-size:1.28em;margin:1.8em 0 1.2em}" +
    "h3{font-size:1.12em;margin:1.6em 0 1em}h4,h5,h6{font-size:1em;margin:1.4em 0 .8em}" +
    "h1::after{content:'';display:block;width:2.4em;height:2px;margin:.7em auto 0;background:" + c.accent + ";opacity:.7}" +
    "blockquote{margin:0 0 1.6em;padding:.8em 1em;border-left:3px solid " + c.accent + ";background:" + c.quote + ";color:" + c.muted + ";font-size:.88em;line-height:1.75;border-radius:0 6px 6px 0}" +
    "blockquote p{text-indent:0;margin:0 0 .4em}blockquote p:last-child{margin:0}" +
    "hr{border:0;height:1px;background:" + c.rule + ";margin:2.2em 25%}" +
    "img{max-width:100%;height:auto;display:block;margin:1.2em auto;border-radius:4px}" +
    "ruby rt{font-size:.5em;font-weight:400;letter-spacing:0;color:" + c.muted + "}" +
    "a{color:inherit;text-decoration:none}sup{font-size:.7em;color:" + c.muted + "}" +
    "pre{white-space:pre-wrap;font-size:.9em}ol,ul{padding-left:1.6em}li{margin:.3em 0}" +
    "table{max-width:100%;display:block;overflow:auto;border-collapse:collapse;font-size:.9em;margin:1em 0}td,th{padding:.2em .6em;vertical-align:top}" +
    "::selection{background:" + c.accent + "55}";
}

export class OfflineEpub {
  private objectUrls: string[] = [];
  private constructor(private zip: ZipArchive, public chapters: SpineEntry[], private coverPath: string | null) {}

  static async open(file: Blob): Promise<OfflineEpub> {
    const zip = new ZipArchive(await file.arrayBuffer());
    const root = xml(await zip.text("META-INF/container.xml"));
    const containerFile = elements(root, "rootfile")[0]?.getAttribute("full-path");
    if (!containerFile) throw new Error("EPUB 缺少书籍描述文件");
    const opf = xml(await zip.text(containerFile));
    const manifest = new Map<string, string>();
    let epub3Cover: string | null = null;
    for (const item of elements(opf, "item")) {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      if (!id || !href) continue;
      const path = pathFrom(containerFile, href.split(/[?#]/)[0]);
      manifest.set(id, path);
      if (item.getAttribute("properties")?.split(/\s+/).includes("cover-image")) epub3Cover = path;
    }
    const legacyCoverId = elements(opf, "meta").find(item =>
      item.getAttribute("name")?.toLowerCase() === "cover")?.getAttribute("content");
    const imagePath = /\.(?:jpe?g|png|webp)$/i;
    const markedCover = epub3Cover || (legacyCoverId ? manifest.get(legacyCoverId) : undefined);
    const fallbackCover = [...manifest.values()].find(path =>
      imagePath.test(path) && /(?:^|\/)cover[^/]*\.(?:jpe?g|png|webp)$/i.test(path));
    const coverPath = markedCover && imagePath.test(markedCover) ? markedCover :
      fallbackCover || null;
    const chapters: SpineEntry[] = [];
    // WS Export opens every book with its own title page ("从维基文库导出")
    // and ends with an about/licence page; neither is part of the work.
    const wikisourceExport = elements(opf, "identifier").some(item => /^https:\/\/[a-z-]+\.wikisource\.org\//.test(item.textContent || ""));
    for (const item of elements(opf, "itemref")) {
      if (item.getAttribute("linear") === "no") continue;
      const href = manifest.get(item.getAttribute("idref") || "");
      if (wikisourceExport && href && /(?:^|\/)(?:title|about)\.xhtml$/.test(href)) continue;
      if (href && /\.(?:xhtml|html|htm)$/i.test(href)) chapters.push({ path: href, title: "第 " + (chapters.length + 1) + " 章" });
    }
    if (!chapters.length) throw new Error("未找到 EPUB 可阅读章节");
    if (chapters.length > MAX_ENTRIES) throw new Error("EPUB 章节过多");
    return new OfflineEpub(zip, chapters, coverPath);
  }

  /** Extract only a declared cover image from the already-downloaded EPUB. */
  async coverImage(): Promise<Blob | null> {
    if (!this.coverPath) return null;
    const extension = this.coverPath.toLowerCase().match(/\.(jpe?g|png|webp)$/)?.[1];
    const mime = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
    try {
      const bytes = await this.zip.read(this.coverPath);
      if (bytes.length < 50 || bytes.length > 2 * 1024 * 1024) return null;
      const signature = mime === "image/png"
        ? bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        : mime === "image/webp"
          ? new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
            new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
          : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!signature) return null;
      return new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
    } catch {
      // A missing or malformed cover must not prevent EPUB reading/downloading.
      return null;
    }
  }

  private clearUrls() {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  async renderChapter(index: number, fontSize: number, theme: "light" | "sepia" | "dark"): Promise<string> {
    this.clearUrls();
    const chapter = this.chapters[index];
    if (!chapter) throw new Error("章节不存在");
    const parsed = new DOMParser().parseFromString(await this.zip.text(chapter.path), "text/html");
    for (const blocked of Array.from(parsed.body.querySelectorAll("script,style,link,iframe,object,embed,form,svg,math,video,audio,base,meta,template"))) blocked.remove();
    stripSiteChrome(parsed.body);
    const heading = parsed.body.querySelector("h1,h2,h3");
    const headingText = heading?.textContent?.replace(/\s+/g, " ").trim();
    if (headingText) chapter.title = headingText.slice(0, 90);
    const allowed = new Set(["P","DIV","SPAN","H1","H2","H3","H4","H5","H6","B","I","EM","STRONG","U","S","BR","HR","BLOCKQUOTE","PRE","CODE","OL","UL","LI","IMG","TABLE","THEAD","TBODY","TR","TD","TH","SUP","SUB","SECTION","ARTICLE","RUBY","RT","RP"]);
    for (const element of Array.from(parsed.body.querySelectorAll("*"))) {
      if (!allowed.has(element.tagName)) {
        element.replaceWith(...Array.from(element.childNodes));
        continue;
      }
      const source = element.getAttribute("src");
      for (const attr of Array.from(element.attributes)) element.removeAttribute(attr.name);
      if (element.tagName === "IMG" && source && !/^(?:data:|https?:|blob:|\/\/)/i.test(source)) {
        try {
          const imagePath = pathFrom(chapter.path, source.split(/[?#]/)[0]);
          const match = imagePath.toLowerCase().match(/\.(png|jpe?g|gif|webp)$/);
          if (match) {
            const mime = match[1] === "png" ? "image/png" : match[1] === "gif" ? "image/gif" : match[1] === "webp" ? "image/webp" : "image/jpeg";
            const bytes = await this.zip.read(imagePath);
            const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
            this.objectUrls.push(url);
            element.setAttribute("src", url);
          }
        } catch { element.remove(); }
      } else if (element.tagName === "IMG") element.remove();
    }
    // Empty paragraphs from exporters only add gaps.
    for (const paragraph of Array.from(parsed.body.querySelectorAll("p"))) {
      if (!paragraph.textContent?.trim() && !paragraph.querySelector("img,br")) paragraph.remove();
    }
    const paragraphs = Array.from(parsed.body.querySelectorAll("p")).slice(0, 80);
    const script = chapterScript(parsed.body.textContent || "");
    // Aozora and many CJK sources already open paragraphs with a full-width
    // space; only indent text that does not carry its own indent.
    const selfIndented = paragraphs.filter(p => /^[\u3000\u00a0]|^ {2}/.test((p.textContent || "").replace(/^[\n\r\t]+/, ""))).length;
    const indented = script !== "latin" && selfIndented < paragraphs.length / 3;
    // Strictly no publisher scripts, styles, network calls or navigation.
    const lang = script === "latin" ? "en" : script === "japanese" ? "ja" : "zh";
    return "<!doctype html><html lang=\"" + lang + "\"><head><meta charset=\"utf-8\">" +
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'\">" +
      "<style>" + chapterStyles(theme, fontSize, script, indented) + "</style></head><body>" +
      parsed.body.innerHTML + "</body></html>";
  }

  destroy(): void { this.clearUrls(); }
}
