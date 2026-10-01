import { describe, expect, it } from "vitest";
import type { BookmarkRecord } from "@/db/dexie";
import {
  buildNip51BookmarkPayload,
  mergeNip51BookmarkRecords,
  NIP51_BOOKMARK_KIND,
} from "@/services/privateBookmarkMirror";

const ACCOUNT = "a".repeat(64);
const E1 = "1".repeat(64);
const E2 = "2".repeat(64);
const E3 = "3".repeat(64);

function record(messageId: string, updatedAt: number, deleted = false): BookmarkRecord {
  return {
    accountPubkey: ACCOUNT,
    messageId,
    createdAt: updatedAt,
    updatedAt,
    deleted,
  };
}

describe("NIP-51 private bookmark mirror", () => {
  it("uses the standard global bookmark kind", () => {
    expect(NIP51_BOOKMARK_KIND).toBe(10003);
  });

  it("keeps newer HaiNei per-item state while importing newer remote membership for older items", () => {
    const merged = mergeNip51BookmarkRecords([
      record(E1, 5_000, false),
      record(E2, 5_000, true),
    ], [E2, E3], 4_000);

    expect(merged.find(item => item.messageId === E1)?.deleted).toBe(false);
    expect(merged.find(item => item.messageId === E2)?.deleted).toBe(true);
    expect(merged.find(item => item.messageId === E3)).toMatchObject({
      messageId: E3,
      deleted: false,
      updatedAt: 4_000,
    });
  });

  it("lets a newer NIP-51 snapshot remove an older local bookmark", () => {
    const merged = mergeNip51BookmarkRecords([
      record(E1, 1_000, false),
      record(E2, 1_000, false),
    ], [E2], 3_000);

    expect(merged.find(item => item.messageId === E1)).toMatchObject({
      deleted: true,
      updatedAt: 3_000,
    });
    expect(merged.find(item => item.messageId === E2)?.deleted).toBe(false);
  });

  it("preserves remote unsupported/public items and makes new HaiNei bookmarks private", () => {
    const payload = buildNip51BookmarkPayload([
      record(E1, 1_000),
      record(E2, 2_000),
      record(E3, 3_000),
    ], {
      publicTags: [
        ["a", `30023:${ACCOUNT}:article`],
        ["e", E1],
      ],
      privateTags: [
        ["e", E2],
        ["a", `30023:${ACCOUNT}:private-article`],
      ],
    });

    expect(payload.publicTags).toEqual([
      ["a", `30023:${ACCOUNT}:article`],
      ["e", E1],
    ]);
    expect(payload.privateTags).toEqual([
      ["e", E2],
      ["a", `30023:${ACCOUNT}:private-article`],
      ["e", E3],
    ]);
  });

  it("removes deleted event references without touching non-event NIP-51 items", () => {
    const payload = buildNip51BookmarkPayload([
      record(E1, 2_000, true),
    ], {
      publicTags: [["e", E1], ["a", `30023:${ACCOUNT}:article`]],
      privateTags: [["a", `30023:${ACCOUNT}:private-article`]],
    });

    expect(payload.publicTags).toEqual([["a", `30023:${ACCOUNT}:article`]]);
    expect(payload.privateTags).toEqual([["a", `30023:${ACCOUNT}:private-article`]]);
  });
});
