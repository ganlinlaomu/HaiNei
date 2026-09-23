import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment } from "@/stores/interactions";
import {
  buildCommentSubmission,
  buildCommentThreads,
  canSubmitComment,
  commentCountIncludingReplies,
  commentDraftAfterSend,
  feedScrollAfterSheetClose,
  shouldCloseCommentSheetDrag
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
    expect(buildCommentSubmission("post", ROOT.author, " hello ", REPLY, ROOT.author)).toEqual({
      messageId: "post", recipientPubkey: REPLY.author, text: "hello", parentCommentId: "reply"
    });
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("interactions.sendComment(");
  });

  it("keeps failed text and prevents a duplicate submit while sending", () => {
    expect(commentDraftAfterSend("保留这段文字", false)).toBe("保留这段文字");
    expect(commentDraftAfterSend("已发送", true)).toBe("");
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("if (!canSubmitComment(text, !!selectedImage.value) || sending.value) return");
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

  it("uses the taller timed sheet and closes only for a sufficient drag or flick", () => {
    expect(shouldCloseCommentSheetDrag(260, 1000, 1000)).toBe(true);
    expect(shouldCloseCommentSheetDrag(80, 1000, 80)).toBe(true);
    expect(shouldCloseCommentSheetDrag(80, 1000, 500)).toBe(false);
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("height:calc(100dvh - 72px)");
    expect(sheet).toContain("320ms cubic-bezier(.22,1,.36,1)");
    expect(sheet).toContain("260ms cubic-bezier(.22,1,.36,1)");
  });

  it("drags the empty body but preserves native scrolling when comments exist", () => {
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain('@pointerdown="startEmptyDrag"');
    expect(sheet).toContain("if (commentCount.value) return");
    expect(sheet).toContain("touch-action:pan-y");
    expect(sheet).toContain("-webkit-overflow-scrolling:touch");
    expect(sheet).toContain(".comment-sheet-body.empty{touch-action:none");
  });

  it("keeps the root toggle before expanded roots and collapses back in place", () => {
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    const card = readFileSync(join(process.cwd(), "src/components/PostCard.vue"), "utf8");
    expect(sheet).toContain("const INITIAL_ROOT_COUNT = 1");
    expect(sheet).toContain("index < INITIAL_ROOT_COUNT || commentsExpanded");
    expect(sheet).toContain("`查看 ${remainingRootCount} 条评论`");
    expect(sheet).toContain('commentsExpanded ? "隐藏评论"');
    expect(sheet).toContain('@click="toggleCommentExpansion"');
    expect(sheet.indexOf('class="thread-toggle root-toggle"')).toBeLessThan(sheet.indexOf('class="comment-thread"'));
    expect(card).not.toContain('class="view-comments"');
  });

  it("keeps reply expansion independent per root and the control before replies", () => {
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("const expandedReplyRoots = ref(new Set<string>())");
    expect(sheet).toContain("toggleReplyThread(thread.root.id)");
    expect(sheet).toContain("isReplyThreadExpanded(thread.root.id)");
    expect(sheet).toContain("`查看 ${thread.replies.length} 条回复`");
    expect(sheet).toContain('isReplyThreadExpanded(thread.root.id) ? "隐藏回复"');
    expect(sheet.indexOf('class="thread-toggle reply-toggle"')).toBeLessThan(sheet.indexOf('class="comment-replies"'));
  });

  it("uses a plain Instagram-style author row and clean empty state", () => {
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain('class: "comment-author-line"');
    expect(sheet).toContain('h("time", formatRelativeTime');
    expect(sheet).toContain(".comment-name{min-width:0;color:#1f2937");
    expect(sheet).toContain(".comment-author-line time{flex-shrink:0;color:#94a3b8;font-size:11px");
    expect(sheet).toContain(".comment-actions{display:flex;align-items:center;gap:6px;min-height:18px;margin-top:3px;color:#94a3b8;font-size:11px");
    expect(sheet).toContain(".comment-actions button{color:#64748b");
    expect(sheet).not.toMatch(/\.comment-name\{[^}]*border-radius/);
    expect(sheet).not.toMatch(/\.comment-actions button\{[^}]*border-radius/);
    expect(sheet).not.toMatch(/\.comment-author-line time\{[^}]*background/);
    expect(sheet).not.toMatch(/\.comment-avatar\{[^}]*background/);
    expect(sheet).toContain("还没有评论");
    expect(sheet).toContain("开始对话。");
    expect(sheet).toContain('class: "comment-mention"');
  });

  it("uses a wide two-sided root separator and a shorter reply separator", () => {
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("grid-template-columns:minmax(48px,1fr) auto minmax(48px,1fr)");
    expect(sheet).toContain(".root-toggle .toggle-line{width:100%");
    expect(sheet).toContain(".reply-toggle .toggle-line{width:24px");
    const rootToggle = sheet.slice(sheet.indexOf('class="thread-toggle root-toggle"'), sheet.indexOf('<article v-if='));
    expect(rootToggle.match(/class="toggle-line"/g)).toHaveLength(2);
    const replyToggle = sheet.slice(sheet.indexOf('class="thread-toggle reply-toggle"'), sheet.indexOf('<div v-if="isReplyThreadExpanded'));
    expect(replyToggle.match(/class="toggle-line"/g)).toHaveLength(1);
  });

  it("derives all root and reply counts only from locally available interactions", () => {
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("buildCommentThreads(interactions.getComments(props.message.id))");
    expect(sheet).toContain("threads.value.length - INITIAL_ROOT_COUNT");
    expect(sheet).toContain("thread.replies.length");
    expect(sheet).not.toContain("fetchProfile");
  });

  it("routes replies to self back to the post author while retaining the reply id", () => {
    const self = ROOT.author;
    const friend = REPLY.author;
    expect(buildCommentSubmission("post", friend, "reply", ROOT, self).recipientPubkey).toBe(friend);
    expect(buildCommentSubmission("post", self, "reply", ROOT, self)).toMatchObject({
      recipientPubkey: self,
      parentCommentId: ROOT.id
    });
    expect(buildCommentSubmission("post", self, "reply", REPLY, self).recipientPubkey).toBe(friend);
  });

  it("allows image-only comments and exposes one-image selection/removal UI", () => {
    expect(canSubmitComment("", false)).toBe(false);
    expect(canSubmitComment("", true)).toBe(true);
    expect(canSubmitComment("text", false)).toBe(true);
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain('accept="image/*"');
    expect(sheet).toContain("removeSelectedImage");
    expect(sheet).toContain("uploadEncryptedCommentImage(selectedImage.value.file");
    expect(sheet).toContain("h(PostImagePreview");
    expect(sheet).toContain("draft.value = commentDraftAfterSend(draft.value, false)");
    expect(sheet).toContain("removeSelectedImage();");
  });

  it("reuses encrypted Blossom media and never inserts a raw image in the comment payload", () => {
    const helper = readFileSync(join(process.cwd(), "src/utils/commentImage.ts"), "utf8");
    expect(helper).toContain("uploadImageToBlossomWithFallback");
    expect(helper).toContain("encryptImageBytes");
    expect(helper).toContain("encodeEncryptedImageRef");
    expect(helper).toContain("storeImageInCache");
    const store = readFileSync(join(process.cwd(), "src/stores/interactions.ts"), "utf8");
    expect(store).toContain("media?: CommentMedia[]");
    expect(store).toContain("media?.slice(0, 1)");
    expect(store).not.toContain("data:image");
  });
});
