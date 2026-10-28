import "fake-indexeddb/auto";
import { reactive, isProxy } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogBook } from "@/services/ebookCatalog";
import {
  saveLibraryBook, getLibraryBook, listLibraryBooks, updateReadingState, deleteLibraryBook,
} from "@/services/ebookLibrary";

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const BOOK: CatalogBook = {
  id: "gutenberg:1342",
  title: "Pride and Prejudice",
  authors: ["Austen, Jane"],
  language: "en",
  epubUrl: "https://www.gutenberg.org/ebooks/1342.epub3.images",
  sourceUrl: "https://www.gutenberg.org/ebooks/1342",
  downloads: 42,
};
afterEach(async () => {
  // Delete records, not the singleton database: Dexie closes its connection
  // when indexedDB.deleteDatabase() triggers versionchange, and this module
  // intentionally keeps one EbookDatabase instance throughout the app session.
  await deleteLibraryBook(ACCOUNT_A, BOOK.id);
  await deleteLibraryBook(ACCOUNT_B, BOOK.id);
});

describe("ebooks IndexedDB clone boundaries", () => {
  it("persists a Vue reactive search result and real EPUB Blob without DataCloneError", async () => {
    const reactiveBook = reactive({ ...BOOK, authors: [...BOOK.authors] });
    expect(isProxy(reactiveBook.authors)).toBe(true);
    expect(() => structuredClone(reactiveBook.authors)).toThrow();

    const bytes = new Uint8Array(128);
    bytes[0] = 0x50;
    bytes[1] = 0x4b;
    const epub = new Blob([bytes], { type: "application/epub+zip" });

    await expect(saveLibraryBook(ACCOUNT_A, reactiveBook, epub)).resolves.toBeUndefined();
    const stored = await getLibraryBook(ACCOUNT_A, BOOK.id);
    expect(stored).toBeDefined();
    expect(stored?.authors).toEqual(["Austen, Jane"]);
    expect(isProxy(stored?.authors)).toBe(false);
    expect(() => structuredClone(stored?.authors)).not.toThrow();
    expect(stored?.file).toBeInstanceOf(Blob);
    expect(stored?.bytes).toBe(bytes.byteLength);
    expect((await stored!.file.arrayBuffer()).byteLength).toBe(bytes.byteLength);
  });

  it("stores EPUB cover Blob locally and preserves it across subsequent book saves", async () => {
    const epub = new Blob([new Uint8Array(128)], { type: "application/epub+zip" });
    const cover = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
    await saveLibraryBook(ACCOUNT_A, BOOK, epub, cover);
    const stored = await getLibraryBook(ACCOUNT_A, BOOK.id);
    expect(stored?.coverBlob).toBeInstanceOf(Blob);
    expect(stored?.coverBlob?.type).toBe("image/jpeg");
    expect(stored?.coverBlob?.size).toBe(4);
    await saveLibraryBook(ACCOUNT_A, BOOK, epub);
    const resaved = await getLibraryBook(ACCOUNT_A, BOOK.id);
    expect(resaved?.coverBlob?.size).toBe(4);
  });

  it("keeps shelves account-scoped and preserves reader progress on repeat saves", async () => {
    const epub = new Blob([new Uint8Array(128)], { type: "application/epub+zip" });
    await saveLibraryBook(ACCOUNT_A, reactive({ ...BOOK, authors: [...BOOK.authors] }), epub);
    expect(await listLibraryBooks(ACCOUNT_B)).toEqual([]);
    await updateReadingState(ACCOUNT_A, BOOK.id, { chapterIndex: 3, chapterPercent: 0.45 });
    await saveLibraryBook(ACCOUNT_A, reactive({ ...BOOK, authors: [...BOOK.authors] }), epub);
    const record = await getLibraryBook(ACCOUNT_A, BOOK.id);
    expect(record?.chapterIndex).toBe(3);
    expect(record?.chapterPercent).toBe(0.45);
  });
});
