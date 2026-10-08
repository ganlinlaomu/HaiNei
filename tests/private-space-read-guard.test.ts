import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canMarkConversationTailRead } from "@/utils/messageReadVisibility";

const visible = {
  hasList: true, sourceFocused: false, searchingHistory: false,
  tailRendered: true, nearBottom: true,
};
describe("PR-FIX-C: source-linked DM read boundaries", () => {
  it("does not advance unread on a historical source jump", () => {
    expect(canMarkConversationTailRead({ ...visible, sourceFocused: true })).toBe(false);
    expect(canMarkConversationTailRead({ ...visible, searchingHistory: true })).toBe(false);
    expect(canMarkConversationTailRead({ ...visible, tailRendered: false })).toBe(false);
    expect(canMarkConversationTailRead({ ...visible, nearBottom: false })).toBe(false);
    expect(canMarkConversationTailRead({ ...visible, hasList: false })).toBe(false);
  });
  it("allows read only when actual latest conversation is visible", () => {
    expect(canMarkConversationTailRead(visible)).toBe(true);
  });
  it("wires historical route focus and explicit jump to visibility guard", () => {
    const screen = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const store = readFileSync(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    expect(screen).toContain("sourceFocusReadSuppressed.value = true");
    expect(screen).toContain("sourceFocusReadSuppressed.value = false");
    expect(screen).toContain("canMarkConversationTailRead({");
    expect(screen).toContain("const latest = windowMessages.value.filter(");
    expect(screen).toContain("if (!sourceFocusReadSuppressed.value)");
    expect(store).toContain("if (readThrough && !requestedReadThrough) return;");
    expect(store).toContain("readThrough ? requestedReadThrough : items.filter(readable).at(-1)");
  });
});
