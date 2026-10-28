import { validGutenbergEpubUrl, type CatalogBook } from "@/services/ebookCatalog";
import { MAX_EPUB_SIZE, checkBookStorageSpace, saveLibraryBook } from "@/services/ebookLibrary";
import { OfflineEpub } from "@/services/ebookEpub";

/** Downloads only verified Gutenberg EPUBs. Complete before IndexedDB commit. */
export async function downloadGutenbergBook(
  account: string,
  book: CatalogBook,
  onProgress: (percent: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!validGutenbergEpubUrl(book.epubUrl)) throw new Error("不受支持的书籍下载地址");
  const proxy = "/api/books/epub?url=" + encodeURIComponent(book.epubUrl);
  const response = await fetch(proxy, { signal, cache: "no-store" });
  if (!response.ok) {
    throw new Error(response.status === 413 ? "文件超过 25MB 限制" :
      "暂时无法下载 EPUB（HTTP " + response.status + "）");
  }
  const headerLength = Number(response.headers.get("Content-Length") || 0);
  if (headerLength > MAX_EPUB_SIZE) throw new Error("文件超过 25MB 限制");
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (!response.body) throw new Error("服务器没有返回文件内容");
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_EPUB_SIZE) throw new Error("文件超过 25MB 限制");
      chunks.push(value);
      onProgress(headerLength > 0 ? Math.min(100, Math.floor(received / headerLength * 100)) : null);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (headerLength && received !== headerLength) throw new Error("文件下载不完整，请重试");
  if (received < 100) throw new Error("下载的文件为空");
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error("下载内容不是 EPUB 文件");
  const file = new Blob([buffer], { type: "application/epub+zip" });
  const verified = await OfflineEpub.open(file);
  verified.destroy();
  await checkBookStorageSpace(received);
  await saveLibraryBook(account, book, file);
  onProgress(100);
}
