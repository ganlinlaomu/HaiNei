import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("notification comment navigation", () => {
  it("targets replies before parent comments", () => {
    const notifications = source("src/views/Notifications.vue");
    expect(notifications).toContain('const targetCommentId = n.type === "mention_comment" ? n.commentId : (n.replyId || n.commentId)');
    expect(notifications).toContain("...(targetCommentId ? { iid: targetCommentId } : {})");
    expect(notifications).not.toContain("iid: n.commentId, rid: n.replyId");
  });

  it("resolves the exact post even when it is outside the Home page window", () => {
    const home = source("src/views/Home.vue");
    expect(home).toContain("syncedMessageRepository.get(keys.pkHex, mid)");
    expect(home).toContain("resolveNotificationPost(mid)");
    expect(home).toContain("insertSortedHomeMessage(displayedMessages.value, targetPost)");
    expect(home).toContain("if (!readyForPending.value || homeAccountPk !== keys.pkHex) return");
    expect(home).toContain("virtualStart.value = Math.max(0, targetIndex - 1)");
    expect(home).toContain("route.query.rid || route.query.iid");
    expect(home).toContain("notificationJumpDone.value = true");
    expect(home).not.toContain("for (let i = 0; i < 40; i++)");
    expect(home).not.toContain("const targetId = iid ?");
  });

  it("centers the exact target inside the comment scroller", () => {
    const sheet = source("src/components/CommentSheet.vue");
    expect(sheet).toContain("centerTargetInCommentBody");
    expect(sheet).toContain('body.scrollTo({ top: Math.max(0, centeredTop), behavior: "auto" })');
    expect(sheet).toContain("revealTargetComment(targetCommentId)");
    expect(sheet).toContain("document.getElementById(`comment-${targetCommentId}`)");
    expect(sheet).not.toContain('target?.scrollIntoView({ block: "center" })');
  });
});
