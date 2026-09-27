import { describe, expect, it } from "vitest";
import {
  audienceGroupCounts,
  audienceGroupsMeta,
  audienceRecipients,
  friendGroupTags,
  normalizeSelectedAudienceGroups,
} from "@/utils/friendAudience";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("friend audience selection", () => {
  it("includes ungrouped accepted friends in all-friends and exposes them as 未分组", () => {
    const friends = [
      { pubkey: A, groups: ["家人"] },
      { pubkey: B, groups: [] },
    ];
    expect(audienceRecipients(friends, true, [])).toEqual([A, B]);
    expect(audienceGroupCounts(friends)).toEqual({
      order: ["家人", "未分组"],
      counts: { 家人: 1, 未分组: 1 },
    });
    expect(audienceRecipients(friends, false, ["未分组"])).toEqual([B]);
  });

  it("trims and deduplicates legacy group labels and recipients", () => {
    const friends = [
      { pubkey: A.toUpperCase(), groups: [" 家人 ", "家人", "", "  "] },
      { pubkey: A, groups: ["家人"] },
      { pubkey: C, group: " 同学 " },
    ];
    expect(friendGroupTags(friends[0])).toEqual(["家人"]);
    expect(audienceGroupCounts(friends)).toEqual({
      order: ["家人", "同学"],
      counts: { 家人: 2, 同学: 1 },
    });
    expect(audienceRecipients(friends, true, [])).toEqual([A, C]);
  });

  it("drops stale selected groups when the live accepted audience changes", () => {
    expect(normalizeSelectedAudienceGroups(
      ["家人", " 已删除 ", "家人"],
      ["家人", "未分组"],
    )).toEqual(["家人"]);
    expect(normalizeSelectedAudienceGroups(["已删除"], ["未分组"])).toEqual([]);
  });

  it("uses friend counts only and emits no all-friends metadata for self-only posts", () => {
    const friends = [
      { pubkey: A, groups: ["家人", "同学"] },
      { pubkey: B, groups: ["家人"] },
    ];
    expect(audienceGroupsMeta(friends, true, [])).toEqual([
      { name: "全部好友", count: 2 },
    ]);
    expect(audienceGroupsMeta([], true, [])).toEqual([]);
    expect(audienceGroupsMeta(friends, false, ["家人", "不存在"])).toEqual([
      { name: "家人", count: 2 },
    ]);
  });
});
