// Review finding #4: the chat marks messages read (and sends read receipts)
// while the page is hidden, and does not catch up when it becomes visible.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canMarkConversationTailRead } from "@/utils/messageReadVisibility";

const atTail = {
  hasList: true, sourceFocused: false, searchingHistory: false,
  tailRendered: true, nearBottom: true, pageVisible: true,
};

describe("review #4: read state follows actual page visibility", () => {
  it("never marks the conversation tail read while the page is hidden", () => {
    expect(canMarkConversationTailRead({ ...atTail, pageVisible: false })).toBe(false);
    expect(canMarkConversationTailRead(atTail)).toBe(true);
  });

  it("passes document visibility into the chat's tail-read gate", () => {
    const screen = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const gate = screen.slice(screen.indexOf("function markVisibleMessagesRead()"));
    expect(gate.slice(0, 800)).toContain('pageVisible: document.visibilityState === "visible"');
  });

  it("catches up on read state when the chat becomes visible again", () => {
    const screen = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const start = screen.indexOf("function handleBurnVisibility()");
    const handler = screen.slice(start, screen.indexOf("\n}\n", start));
    expect(handler).toContain("markVisibleMessagesRead()");
  });
});
