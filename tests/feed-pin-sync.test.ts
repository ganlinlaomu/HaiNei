import { describe, expect, it } from "vitest";
import { mergeNamespaceData } from "@/services/accountStateSync";

const A = "1".repeat(64);
const B = "2".repeat(64);

describe("Home pin sync", () => {
  it("merges pins across devices by latest change, keeping unpin tombstones", () => {
    const merged = mergeNamespaceData("feed_preferences",
      { hidden: [], muted: [], pinned: [{ id: A, updatedAt: 10, deleted: false }] },
      { hidden: [], muted: [], pinned: [{ id: A, updatedAt: 20, deleted: true }, { id: B, updatedAt: 5, deleted: false }] });
    expect(merged.pinned).toEqual(expect.arrayContaining([
      { id: A, updatedAt: 20, deleted: true },
      { id: B, updatedAt: 5, deleted: false },
    ]));
  });
});
