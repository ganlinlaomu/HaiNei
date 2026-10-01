import { describe, expect, it, vi } from "vitest";
import { scanMessageSearchPages } from "../src/utils/messageSearch";

type Row = { createdAt: number; id: string };

describe("paged DM search scan", () => {
  it("discards an in-flight page after cancellation and schedules no later batch", async () => {
    const controller = new AbortController();
    let resolvePage!: (rows: Row[]) => void;
    const loadPage = vi.fn(() => new Promise<Row[]>(resolve => { resolvePage = resolve; }));
    const onPage = vi.fn();

    const pending = scanMessageSearchPages({
      batchSize: 2,
      signal: controller.signal,
      shouldContinue: () => true,
      loadPage,
      onPage,
    });

    controller.abort();
    resolvePage([{ createdAt: 2, id: "b" }, { createdAt: 3, id: "c" }]);

    await expect(pending).resolves.toEqual({ scanned: 0, complete: false, cancelled: true });
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(onPage).not.toHaveBeenCalled();
  });

  it("stops after the current page when the active account changes", async () => {
    let activeAccount = "a";
    const loadPage = vi.fn(async () => [
      { createdAt: 2, id: "b" },
      { createdAt: 3, id: "c" },
    ]);
    const onPage = vi.fn(() => { activeAccount = "other"; });

    const result = await scanMessageSearchPages({
      batchSize: 2,
      shouldContinue: () => activeAccount === "a",
      loadPage,
      onPage,
    });

    expect(result).toEqual({ scanned: 2, complete: false, cancelled: true });
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledTimes(1);
  });

  it("uses the oldest row cursor so same-timestamp page boundaries do not skip ids", async () => {
    const pages = new Map<string, Row[]>([
      ["start", [{ createdAt: 10, id: "c" }, { createdAt: 10, id: "d" }]],
      ["10:c", [{ createdAt: 9, id: "z" }, { createdAt: 10, id: "a" }]],
      ["9:z", [{ createdAt: 8, id: "x" }]],
    ]);
    const seen: string[] = [];
    const cursors: string[] = [];

    const result = await scanMessageSearchPages({
      batchSize: 2,
      shouldContinue: () => true,
      loadPage: async before => {
        const key = before ? `${before.createdAt}:${before.id}` : "start";
        cursors.push(key);
        return pages.get(key) || [];
      },
      onPage: rows => { seen.push(...rows.map(row => row.id)); },
    });

    expect(cursors).toEqual(["start", "10:c", "9:z"]);
    expect(seen).toEqual(["c", "d", "z", "a", "x"]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(result).toEqual({ scanned: 5, complete: true, cancelled: false });
  });
});
