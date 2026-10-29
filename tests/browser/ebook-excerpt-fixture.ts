// Browser fixture: the real EbookReader on a generated EPUB, for driving the
// long-press excerpt gesture with real touch input (tests/browser/run-ebook-excerpt.mjs).
import { createApp, h } from "vue";
import { createPinia } from "pinia";
import { RouterView, createMemoryHistory, createRouter } from "vue-router";
import EbookReader from "@/views/EbookReader.vue";
import { saveLibraryBook } from "@/services/ebookLibrary";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";

function storedZip(files: Array<[string, string]>): Blob {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = encoder.encode(name), data = encoder.encode(text);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 10, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 10, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local); centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, end] as BlobPart[], { type: "application/epub+zip" });
}

const paragraphs = Array.from({ length: 12 }, (_, i) =>
  `<p>第${i + 1}段：他说：「天亮了。」我们出发吧！路还很长，河水慢慢地流着。It is a truth universally acknowledged.</p>`).join("");
const epub = storedZip([
  ["mimetype", "application/epub+zip"],
  ["META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
  ["OEBPS/content.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`],
  ["OEBPS/ch1.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><h1>第一章</h1>${paragraphs}</body></html>`],
]);

const pinia = createPinia();
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/books/read/:id", component: EbookReader },
    { path: "/:rest(.*)*", component: { render: () => h("p", "other") } },
  ],
});
const app = createApp({ render: () => h(RouterView) }).use(pinia).use(router);
const account = "a".repeat(64);
useKeyStore(pinia).pkHex = account;
await saveLibraryBook(account, { id: "fixture", title: "边城", authors: ["沈从文"], language: "zh", sourceUrl: "" }, epub);
await router.push("/books/read/fixture");
app.mount("#app");
(window as any).__ui = useUIStore(pinia);
