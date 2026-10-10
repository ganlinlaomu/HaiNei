import { describe, expect, it } from "vitest";
import {
  HAINEI_BOT_PUBKEY_HEX,
  audienceGroupCounts,
  audienceGroupsMeta,
  audienceRecipients,
  friendGroupTags,
  isExcludedPostRecipient,
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

  it("excludes the HaiNei AI bot from all-friends, selected groups, and audience metadata", () => {
    const bot = HAINEI_BOT_PUBKEY_HEX;
    const friends = [
      { pubkey: A, groups: ["家人"] },
      { pubkey: bot.toUpperCase(), groups: ["家人", "机器人"] },
      { pubkey: B, groups: ["同学"] },
    ];
    expect(isExcludedPostRecipient(bot.toUpperCase())).toBe(true);
    expect(isExcludedPostRecipient(A)).toBe(false);
    expect(audienceRecipients(friends, true, [])).toEqual([A, B]);
    expect(audienceRecipients(friends, false, ["家人", "机器人"])).toEqual([A]);
    expect(audienceRecipients(friends, false, ["机器人"])).toEqual([]);
    expect(audienceGroupCounts(friends)).toEqual({
      order: ["家人", "同学"],
      counts: { 家人: 1, 同学: 1 },
    });
    expect(audienceGroupsMeta(friends, true, [])).toEqual([{ name: "全部好友", count: 2 }]);
    expect(audienceGroupsMeta(friends, false, ["家人", "机器人"])).toEqual([
      { name: "家人", count: 1 },
    ]);
  });

  it("treats a bot-only accepted friend list as self-only for posting", () => {
    const friends = [{ pubkey: HAINEI_BOT_PUBKEY_HEX, groups: ["未分组"] }];
    expect(audienceRecipients(friends, true, [])).toEqual([]);
    expect(audienceRecipients(friends, false, ["未分组"])).toEqual([]);
    expect(audienceGroupsMeta(friends, true, [])).toEqual([]);
    expect(audienceGroupCounts(friends)).toEqual({ order: [], counts: {} });
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
