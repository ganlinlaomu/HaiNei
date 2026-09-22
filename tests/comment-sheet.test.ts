import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment } from "@/stores/interactions";
import {
  buildCommentSubmission,
  buildCommentThreads,
  commentCountIncludingReplies,
  commentDraftAfterSend,
  feedScrollAfterSheetClose
} from "@/utils/commentThreads";

const ROOT: Comment = {
  id: "root", messageId: "post", author: "a".repeat(64), text: "root",
  timestamp: 1, type: "comment"
};
const REPLY: Comment = {
  id: "reply", messageId: "post", author: "b".repeat(64), text: "reply",
  timestamp: 2, type: "comment", parentCommentId: "root"
};
const NESTED: Comment = {
  id: "nested", messageId: "post", author: "c".repeat(64), text: "nested",
  timestamp: 3, type: "comment", parentCommentId: "reply"
};

describe("comment bottom sheet", () => {
  it("opens from the comment action without route navigation", () => {
    const card = readFileSync(join(process.cwd(), "src/components/PostCard.vue"), "utf8");
    expect(card).toContain("<CommentSheet");
    expect(card).toContain('@click="toggleComments"');
    expect(card).not.toContain("router.push({ path: '/post'");
  });

  it("renders roots and flattens nested replies to one visual level", () => {
    const threads = buildCommentThreads([ROOT, REPLY, NESTED]);
    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("root");
    expect(threads[0].replies.map(item => item.id)).toEqual(["reply", "nested"]);
  });

  it("sets the actual reply id and recipient for existing interaction sending", () => {
    expect(buildCommentSubmission("post", ROOT.author, " hello ", REPLY)).toEqual({
      messageId: "post", recipientPubkey: REPLY.author, text: "hello", parentCommentId: "reply"
    });
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("interactions.sendComment(");
  });

  it("keeps failed text and prevents a duplicate submit while sending", () => {
    expect(commentDraftAfterSend("保留这段文字", false)).toBe("保留这段文字");
    expect(commentDraftAfterSend("已发送", true)).toBe("");
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("if (!text || sending.value) return");
  });

  it("uses private avatars and shared profile navigation for comment authors", () => {
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("ProfileAvatar");
    expect(sheet).toContain("openProfile(router, keys.pkHex, pubkey, event)");
  });

  it("counts replies and restores the unchanged feed scroll position on close", () => {
    expect(commentCountIncludingReplies([ROOT, REPLY, NESTED])).toBe(3);
    expect(feedScrollAfterSheetClose(428)).toBe(428);
  });
});
