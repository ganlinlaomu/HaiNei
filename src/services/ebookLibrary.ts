import Dexie, { type Table } from "dexie";
import type { CatalogBook } from "@/services/ebookCatalog";

export const MAX_EPUB_SIZE = 25 * 1024 * 1024;

export type LibraryBook = Omit<CatalogBook, "epubUrl" | "downloads"> & {
  accountPubkey: string;
  file: Blob;
  bytes: number;
  downloadedAt: number;
  chapterIndex: number;
  chapterPercent: number;
  fontSize: number;
  theme: "light" | "sepia" | "dark";
};

class EbookDatabase extends Dexie {
  books!: Table<LibraryBook, [string, string]>;
  constructor() {
    super("hainei_ebooks_v1");
    this.version(1).stores({ books: "&[accountPubkey+id],accountPubkey,downloadedAt" });
  }
}

const database = new EbookDatabase();

function ensureAccount(account: string): void {
  if (!/^[0-9a-f]{64}$/i.test(account)) throw new Error("请先登录海内账号");
}

export async function listLibraryBooks(account: string): Promise<LibraryBook[]> {
  ensureAccount(account);
  const rows = await database.books.where("accountPubkey").equals(account).toArray();
  return rows.sort((a, b) => b.downloadedAt - a.downloadedAt);
}

export async function getLibraryBook(account: string, id: string): Promise<LibraryBook | undefined> {
  ensureAccount(account);
  return database.books.get([account, id]);
}

export async function saveLibraryBook(account: string, book: CatalogBook, file: Blob): Promise<void> {
  ensureAccount(account);
  if (file.size < 100 || file.size > MAX_EPUB_SIZE) throw new Error("EPUB 文件大小不受支持（最大 25MB）");
  const existing = await getLibraryBook(account, book.id);
  await database.books.put({
    accountPubkey: account,
    id: book.id,
    title: book.title,
    // Vue ref() turns catalogue result arrays into reactive Proxy objects.
    // IndexedDB structured clone rejects Proxies (DataCloneError), so copy
    // only primitive author names into a fresh ordinary array.
    authors: Array.from(book.authors, author => String(author)),
    language: book.language,
    coverUrl: book.coverUrl,
    sourceUrl: book.sourceUrl,
    file,
    bytes: file.size,
    downloadedAt: Date.now(),
    chapterIndex: existing?.chapterIndex ?? 0,
    chapterPercent: existing?.chapterPercent ?? 0,
    fontSize: existing?.fontSize ?? 18,
    theme: existing?.theme ?? "light",
  });
}

export async function updateReadingState(account: string, id: string, patch: Partial<Pick<LibraryBook, "chapterIndex" | "chapterPercent" | "fontSize" | "theme">>): Promise<void> {
  ensureAccount(account);
  await database.books.update([account, id], patch);
}

export async function deleteLibraryBook(account: string, id: string): Promise<void> {
  ensureAccount(account);
  await database.books.delete([account, id]);
}

export async function checkBookStorageSpace(bytes: number): Promise<void> {
  if (!navigator.storage?.estimate) return;
  const { quota, usage } = await navigator.storage.estimate();
  if (typeof quota === "number" && typeof usage === "number" && quota - usage < bytes * 1.5) {
    throw new Error("设备可用网页存储空间不足，请清理空间后重试");
  }
}

export function exportLibraryBook(book: LibraryBook): void {
  const link = document.createElement("a");
  const url = URL.createObjectURL(book.file);
  link.href = url;
  link.download = (book.title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 72) || "book") + ".epub";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
