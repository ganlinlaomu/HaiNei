import type { CatalogBook } from "@/services/ebookCatalog";

/**
 * Static first-screen selections. No book catalogue request is necessary to
 * open Discover; the links are Gutenberg's published English EPUB editions.
 * US public-domain metadata does not imply worldwide public-domain status.
 */
const titles = [
  [1342, "Pride and Prejudice", "Austen, Jane", "《傲慢与偏见》 · 爱情与成长"],
  [11, "Alice's Adventures in Wonderland", "Carroll, Lewis", "《爱丽丝梦游仙境》 · 奇幻冒险"],
  [1661, "The Adventures of Sherlock Holmes", "Doyle, Arthur Conan", "《福尔摩斯探案集》 · 推理短篇"],
  [514, "Little Women", "Alcott, Louisa May", "《小妇人》 · 家庭与成长"],
  [84, "Frankenstein; or, The Modern Prometheus", "Shelley, Mary Wollstonecraft", "《弗兰肯斯坦》 · 科学与人性"],
  [174, "The Picture of Dorian Gray", "Wilde, Oscar", "《道林·格雷的画像》 · 哥特小说"],
  [98, "A Tale of Two Cities", "Dickens, Charles", "《双城记》 · 历史文学"],
  [2701, "Moby Dick; Or, The Whale", "Melville, Herman", "《白鲸》 · 海洋冒险"],
] as const;

export const FEATURED_BOOKS: CatalogBook[] = titles.map(([id, title, author]) => ({
  id: "gutenberg:" + id,
  title,
  authors: [author],
  language: "en",
  epubUrl: "https://www.gutenberg.org/ebooks/" + id + ".epub3.images",
  sourceUrl: "https://www.gutenberg.org/ebooks/" + id,
  downloads: 0,
}));

const notes: Record<string, string> = Object.fromEntries(
  titles.map(([id, , , description]) => ["gutenberg:" + id, description]),
);

export function featuredNote(id: string): string { return notes[id] || ""; }
