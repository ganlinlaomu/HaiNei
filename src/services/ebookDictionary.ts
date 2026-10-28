/**
 * Offline ECDICT lookup. User installs a 50k-word pack once; no text selection
 * ever leaves the device. Dictionary files stay outside the app-shell cache.
 */
export type DictionaryEntry = { word: string; phonetic: string; translation: string };
type DictionaryShard = {
  words: Record<string, [string, string]>;
  forms: Record<string, string>;
};
type DictionaryManifest = {
  version: "v1";
  count: number;
  files: string[];
  dataBytes: number;
};
const PREFIX = "/ebook-dictionary/v1/";
const CACHE_NAME = "hainei-ebook-ecdict-v1";
const MARKER = PREFIX + "installed";
const LETTERS = [..."abcdefghijklmnopqrstuvwxyz"];
const SHARDS = LETTERS.map(letter => letter + ".json");
const memory = new Map<string, DictionaryShard>();

export function normalizeSelection(value: string): string | null {
  const word = value.trim().replace(/^['"“”‘’(\[{]+|['"“”‘’)\]},.;:!?]+$/g, "")
    .replace(/[\u2019\u2018]/g, "'").toLowerCase();
  return /^[a-z]+(?:['-][a-z]+)*$/.test(word) && word.length <= 40 ? word : null;
}

function storage(): CacheStorage {
  if (typeof caches === "undefined") throw new Error("当前浏览器不支持离线词库缓存");
  return caches;
}

export async function isDictionaryInstalled(): Promise<boolean> {
  try {
    return !!(await (await storage().open(CACHE_NAME)).match(MARKER));
  } catch { return false; }
}

export async function installDictionary(onProgress: (done: number, total: number) => void): Promise<void> {
  const store = storage();
  if (await isDictionaryInstalled()) { onProgress(SHARDS.length, SHARDS.length); return; }
  const cache = await store.open(CACHE_NAME);
  try {
    const response = await fetch(PREFIX + "manifest.json", { cache: "no-store" });
    if (!response.ok) throw new Error("词典文件尚未部署，请稍后重试");
    const manifest = await response.json() as DictionaryManifest;
    if (manifest.version !== "v1" || manifest.count !== 50_000 ||
      manifest.files.join(",") !== SHARDS.join(",") ||
      !Number.isSafeInteger(manifest.dataBytes) || manifest.dataBytes <= 0 ||
      manifest.dataBytes > 30 * 1024 * 1024) {
      throw new Error("词典清单校验失败");
    }
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    if (estimate && typeof estimate.quota === "number" && typeof estimate.usage === "number" &&
      estimate.quota - estimate.usage < manifest.dataBytes * 1.5) {
      throw new Error("本机存储空间不足，无法安装离线词典");
    }
    let done = 0;
    onProgress(done, SHARDS.length);
    for (const name of SHARDS) {
      const path = PREFIX + name;
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error("词典下载失败，请联网后重试");
      const text = await res.text();
      const parsed = JSON.parse(text) as DictionaryShard;
      if (!parsed || !parsed.words || !parsed.forms ||
        typeof parsed.words !== "object" || typeof parsed.forms !== "object") {
        throw new Error("词典数据格式异常");
      }
      await cache.put(path, new Response(text, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }));
      onProgress(++done, SHARDS.length);
    }
    // Write completion marker LAST, so interruption never claims a full pack.
    await cache.put(MARKER, new Response("50k/v1"));
    memory.clear();
  } catch (error) {
    // Keep existing EPUB / IndexedDB untouched if an install is interrupted.
    await store.delete(CACHE_NAME).catch(() => {});
    throw error;
  }
}

async function shard(letter: string): Promise<DictionaryShard | null> {
  if (!LETTERS.includes(letter)) return null;
  const existing = memory.get(letter);
  if (existing) return existing;
  const cache = await storage().open(CACHE_NAME);
  const response = await cache.match(PREFIX + letter + ".json");
  if (!response) return null;
  const data = await response.json() as DictionaryShard;
  if (!data?.words || !data?.forms) return null;
  if (memory.size >= 3) memory.delete(memory.keys().next().value as string);
  memory.set(letter, data);
  return data;
}

export async function lookupDictionary(word: string): Promise<DictionaryEntry | null> {
  const key = normalizeSelection(word);
  if (!key || !(await isDictionaryInstalled())) return null;
  const first = await shard(key[0]);
  if (!first) return null;
  const base = Object.hasOwn(first.words, key) ? key : first.forms[key];
  if (!base || !/^[a-z]/.test(base)) return null;
  const source = base[0] === key[0] ? first : await shard(base[0]);
  const record = source?.words[base];
  return record ? { word: base, phonetic: record[0], translation: record[1] } : null;
}

export const DICTIONARY_ATTRIBUTION = "ECDICT（MIT 许可）";
