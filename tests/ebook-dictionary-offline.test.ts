import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeSelection, isDictionaryInstalled, installDictionary, lookupDictionary } from "@/services/ebookDictionary";

type MockStore = Map<string, Response>;
function makeCacheStorage() {
  const stores = new Map<string, MockStore>();
  const api = {
    open: vi.fn(async (name: string) => {
      let items = stores.get(name);
      if (!items) { items = new Map(); stores.set(name, items); }
      const backing = items;
      return {
        match: async (path: string) => backing.get(path)?.clone(),
        put: async (path: string, data: Response) => { backing.set(path, data.clone()); },
      };
    }),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  };
  vi.stubGlobal("caches", api);
  vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: 100 * 1024 * 1024, usage: 0 }) } });
  return api;
}
afterEach(() => vi.unstubAllGlobals());

describe("offline ECDICT reader dictionary", () => {
  it("accepts selected English words and rejects phrases and arbitrary content", () => {
    expect(normalizeSelection(" acknowledged ")).toBe("acknowledged");
    expect(normalizeSelection("“Don't!”")).toBe("don't");
    expect(normalizeSelection("well-known")).toBe("well-known");
    expect(normalizeSelection("some other words")).toBeNull();
    expect(normalizeSelection("<script>")).toBeNull();
    expect(normalizeSelection("中文")).toBeNull();
  });

  it("requires explicit install before offline lookup and resolves inflected words", async () => {
    makeCacheStorage();
    expect(await isDictionaryInstalled()).toBe(false);
    expect(await lookupDictionary("walked")).toBeNull();
    const letters = [..."abcdefghijklmnopqrstuvwxyz"];
    const files = letters.map(letter => letter + ".json");
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      fetched.push(path);
      if (path.endsWith("manifest.json")) {
        return new Response(JSON.stringify({ version:"v1", count:50000, dataBytes: 7_000_000, files }), {status:200});
      }
      const letter = path.split("/").pop()?.[0];
      const shard = letter === "w"
        ? { words: { walk: ["wɔːk","v. 走；步行"] }, forms: { walked: "walk" } }
        : { words: {}, forms: {} };
      return new Response(JSON.stringify(shard), {status:200});
    }));
    const progress: number[] = [];
    await installDictionary((done) => progress.push(done));
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(26);
    expect(fetched).toHaveLength(27);
    expect(await isDictionaryInstalled()).toBe(true);
    expect(await lookupDictionary("Walked")).toEqual({
      word:"walk", phonetic:"wɔːk", translation:"v. 走；步行",
    });
    await installDictionary(() => {});
    expect(fetched).toHaveLength(27);
  });

  it("never marks a partially downloaded dictionary as installed", async () => {
    const storage = makeCacheStorage();
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path.endsWith("manifest.json")) return new Response(JSON.stringify({
        version:"v1", count:50000, dataBytes:6_000_000,
        files:[..."abcdefghijklmnopqrstuvwxyz"].map(letter => letter + ".json"),
      }));
      if (path.endsWith("b.json")) throw new TypeError("Load failed");
      return new Response(JSON.stringify({words:{},forms:{}}));
    }));
    await expect(installDictionary(() => {})).rejects.toThrow();
    expect(await isDictionaryInstalled()).toBe(false);
    expect(storage.delete).toHaveBeenCalled();
  });

  it("reader keeps EPUB iframe scripts disabled, with an opt-in download", async () => {
    const { readFileSync } = await import("node:fs");
    const view = readFileSync("src/views/EbookReader.vue", "utf8");
    expect(view).toContain('sandbox="allow-same-origin"');
    expect(view).not.toContain('sandbox="allow-scripts');
    expect(view).toContain('@click="lookupTappedWord"');
    expect(view).toContain("normalizeSelection");
    expect(view).toContain("downloadDictionary");
    expect(view).toContain("SpeechSynthesisUtterance");
  });
});
