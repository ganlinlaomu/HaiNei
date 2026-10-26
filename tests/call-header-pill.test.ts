import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectedTabPill } from "@/utils/tabPillGeometry";

const calls = readFileSync("src/views/Calls.vue", "utf8");
const conversations = readFileSync("src/views/Conversations.vue", "utf8");
describe("shared centered segmented filter", () => {
  it("uses HeaderSegmented in both pages while retaining existing filtering", () => {
    expect(calls).toContain("<HeaderSegmented");
    expect(calls).toContain('@update:model-value="missedOnly = $event === \'missed\'"');
    expect(calls).toContain("!missedOnly.value || item.missed");
    expect(conversations).toContain("<HeaderSegmented");
    expect(conversations).toContain('filterMode.value === "unread" && conversation.unread <= 0');
    expect(conversations).toContain('"暂无未读私信"');
    expect(calls).not.toContain('class="calls-filters"');
    expect(conversations).not.toContain('class="conversation-filter"');
  });
  it("calculates the sliding tab offset using the same geometry", () => {
    expect(selectedTabPill([{key:"all",offsetLeft:3,offsetWidth:95},{key:"missed",offsetLeft:100,offsetWidth:116}], "missed"))
      .toEqual({translateX:100,width:116});
  });
});
