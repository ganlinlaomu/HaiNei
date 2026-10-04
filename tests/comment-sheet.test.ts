import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment } from "@/stores/interactions";
import {
  buildCommentSubmission,
  buildCommentThreads,
  canSubmitComment,
  canStartCommentSheetBodyDrag,
  commentCountIncludingReplies,
  commentDraftAfterSend,
  createCommentSheetDragGesture,
  feedScrollAfterSheetClose,
  finishCommentSheetDragGesture,
  shouldCloseCommentSheetDrag,
  updateCommentSheetDragGesture
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

  it("preserves ordering when replies arrive before their parents", () => {
    const threads = buildCommentThreads([NESTED, REPLY, ROOT]);
    expect(threads.map(thread => thread.root.id)).toEqual(["root"]);
    expect(threads[0].replies.map(item => item.id)).toEqual(["nested", "reply"]);
  });

  it("preserves orphan-chain, self-reference, and multi-node-cycle behavior", () => {
    const orphan: Comment = {
      ...ROOT,
      id: "orphan",
      parentCommentId: "missing"
    };
    const orphanChild: Comment = {
      ...REPLY,
      id: "orphan-child",
      parentCommentId: "orphan"
    };
    expect(buildCommentThreads([orphan, orphanChild]).map(thread => ({
      root: thread.root.id,
      replies: thread.replies.map(reply => reply.id)
    }))).toEqual([
      { root: "orphan", replies: [] },
      { root: "orphan-child", replies: [] }
    ]);

    const self: Comment = { ...ROOT, id: "self", parentCommentId: "self" };
    expect(buildCommentThreads([self])).toEqual([{ root: self, replies: [] }]);

    const cycleA: Comment = { ...ROOT, id: "cycle-a", parentCommentId: "cycle-b" };
    const cycleB: Comment = { ...REPLY, id: "cycle-b", parentCommentId: "cycle-c" };
    const cycleC: Comment = { ...NESTED, id: "cycle-c", parentCommentId: "cycle-a" };
    expect(buildCommentThreads([cycleA, cycleB, cycleC])).toEqual([]);
  });

  it("handles a ten-thousand-comment reply chain iteratively", () => {
    const comments: Comment[] = [ROOT];
    for (let index = 1; index < 10_000; index += 1) {
      comments.push({
        ...REPLY,
        id: `deep-${index}`,
        parentCommentId: index === 1 ? ROOT.id : `deep-${index - 1}`,
        timestamp: index + 1
      });
    }
    const threads = buildCommentThreads(comments);
    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe(ROOT.id);
    expect(threads[0].replies).toHaveLength(9_999);
    expect(threads[0].replies.at(-1)?.id).toBe("deep-9999");
  });

  it("keeps parent-chain property access within a linear upper bound", () => {
    let parentReads = 0;
    const comments: Comment[] = [];
    for (let index = 0; index < 4_000; index += 1) {
      const comment = {
        ...ROOT,
        id: `linear-${index}`,
        timestamp: index + 1
      } as Comment;
      Object.defineProperty(comment, "parentCommentId", {
        configurable: true,
        enumerable: true,
        get() {
          parentReads += 1;
          return index === 0 ? undefined : `linear-${index - 1}`;
        }
      });
      comments.push(comment);
    }

    const threads = buildCommentThreads(comments);
    expect(threads).toHaveLength(1);
    expect(parentReads).toBeLessThanOrEqual(comments.length * 2);
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
    expect(shouldCloseCommentSheetDrag(8, 1000, 1)).toBe(false);
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("height:calc(100dvh - 72px)");
    expect(sheet).toContain("320ms cubic-bezier(.22,1,.36,1)");
    expect(sheet).toContain("260ms cubic-bezier(.22,1,.36,1)");
  });

  it("allows empty and populated short bodies to start a pull-down without depending on comment count", () => {
    const shortBody = {
      scrollTop: 0,
      scrollHeight: 420,
      clientHeight: 520,
      interactiveTarget: false,
      pointerCount: 1
    };
    expect(canStartCommentSheetBodyDrag({ ...shortBody, commentCount: 0 })).toBe(true);
    expect(canStartCommentSheetBodyDrag({ ...shortBody, commentCount: 4 })).toBe(true);
  });

  it("preserves native scrolling for long lists away from the top and hands off only on a later top-edge gesture", () => {
    expect(canStartCommentSheetBodyDrag({
      commentCount: 20,
      scrollTop: 180,
      scrollHeight: 1600,
      clientHeight: 520,
      interactiveTarget: false,
      pointerCount: 1
    })).toBe(false);
    expect(canStartCommentSheetBodyDrag({
      commentCount: 20,
      scrollTop: 0,
      scrollHeight: 1600,
      clientHeight: 520,
      interactiveTarget: false,
      pointerCount: 1
    })).toBe(true);

    let gesture = createCommentSheetDragGesture(20, 100, 0, 800);
    const upward = updateCommentSheetDragGesture(gesture, 20, 70, 0);
    gesture = upward.gesture;
    expect(gesture.phase).toBe("native");
    expect(upward.preventDefault).toBe(false);
    expect(finishCommentSheetDragGesture(gesture, 80)).toBe("none");
  });

  it("closes on a deliberate downward pull or valid flick and rebounds below threshold", () => {
    let closeGesture = createCommentSheetDragGesture(20, 100, 0, 800);
    closeGesture = updateCommentSheetDragGesture(closeGesture, 24, 330, 0).gesture;
    expect(closeGesture.phase).toBe("dragging");
    expect(finishCommentSheetDragGesture(closeGesture, 500)).toBe("close");

    let flickGesture = createCommentSheetDragGesture(20, 100, 0, 800);
    const flickUpdate = updateCommentSheetDragGesture(flickGesture, 22, 170, 0);
    flickGesture = flickUpdate.gesture;
    expect(flickUpdate.preventDefault).toBe(true);
    expect(finishCommentSheetDragGesture(flickGesture, 80)).toBe("close");

    let reboundGesture = createCommentSheetDragGesture(20, 100, 0, 800);
    reboundGesture = updateCommentSheetDragGesture(reboundGesture, 22, 155, 0).gesture;
    expect(finishCommentSheetDragGesture(reboundGesture, 400)).toBe("rebound");
  });

  it("never closes horizontal, multi-touch, cancelled, selection, or interactive-input gestures", () => {
    expect(canStartCommentSheetBodyDrag({
      commentCount: 3,
      scrollTop: 0,
      scrollHeight: 900,
      clientHeight: 520,
      interactiveTarget: false,
      pointerCount: 2
    })).toBe(false);
    expect(canStartCommentSheetBodyDrag({
      commentCount: 3,
      scrollTop: 0,
      scrollHeight: 900,
      clientHeight: 520,
      interactiveTarget: true,
      pointerCount: 1
    })).toBe(false);

    let horizontal = createCommentSheetDragGesture(20, 100, 0, 800);
    const horizontalUpdate = updateCommentSheetDragGesture(horizontal, 80, 118, 0);
    horizontal = horizontalUpdate.gesture;
    expect(horizontal.phase).toBe("native");
    expect(horizontalUpdate.preventDefault).toBe(false);
    expect(finishCommentSheetDragGesture(horizontal, 50)).toBe("none");

    const selection = createCommentSheetDragGesture(20, 100, 0, 800);
    const selectionHold = updateCommentSheetDragGesture(selection, 20, 103, 0);
    expect(selectionHold.gesture.phase).toBe("pending");
    expect(selectionHold.preventDefault).toBe(false);
    expect(finishCommentSheetDragGesture(selectionHold.gesture, 700)).toBe("none");

    let cancelled = createCommentSheetDragGesture(20, 100, 0, 800);
    cancelled = updateCommentSheetDragGesture(cancelled, 20, 360, 0).gesture;
    expect(finishCommentSheetDragGesture(cancelled, 300, true)).toBe("cancel");
  });

  it("starts clean after a cancelled drag so reopening cannot inherit stale close state", () => {
    let first = createCommentSheetDragGesture(0, 0, 0, 800);
    first = updateCommentSheetDragGesture(first, 0, 300, 0).gesture;
    expect(finishCommentSheetDragGesture(first, 300, true)).toBe("cancel");

    let reopened = createCommentSheetDragGesture(0, 0, 1000, 800);
    reopened = updateCommentSheetDragGesture(reopened, 0, 40, 0).gesture;
    expect(finishCommentSheetDragGesture(reopened, 1400)).toBe("rebound");
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
    expect(sheet).toContain(":deep(.comment-name){min-width:0;color:#1f2937");
    expect(sheet).toContain(":deep(.comment-author-line time){flex-shrink:0;color:#8e8e8e;font-size:11px");
    expect(sheet).toContain(":deep(.comment-actions){display:flex;align-items:center;gap:6px;min-height:17px;margin-top:3px;color:#8e8e8e;font-size:11px");
    expect(sheet).toContain(":deep(.comment-actions button){color:#8e8e8e;font-size:11px");
    expect(sheet).toContain("appearance:none;-webkit-appearance:none");
    expect(sheet).toContain("border-radius:0;background:transparent;box-shadow:none");
    expect(sheet).not.toMatch(/:deep\(\.comment-name\)\{[^}]*background:(?!transparent)/);
    expect(sheet).not.toMatch(/:deep\(\.comment-actions button\)\{[^}]*background:(?!transparent)/);
    expect(sheet).not.toMatch(/:deep\(\.comment-author-line time\)\{[^}]*background/);
    expect(sheet).not.toMatch(/:deep\(\.comment-avatar\)\{[^}]*background/);
    expect(sheet).toContain("还没有评论");
    expect(sheet).toContain("开始对话。");
    expect(sheet).toContain('h(MentionText, { text: rowProps.comment.text })');
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

  it("uses a focus-expanding multiline comment composer where Enter inserts a newline", () => {
    const sheet = readFileSync(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    expect(sheet).toContain("<textarea");
    expect(sheet).toContain('rows="1"');
    expect(sheet).toContain('enterkeyhint="enter"');
    expect(sheet).toContain("resizeComposerTextarea(composer.value, commentComposerFocused");
    expect(sheet).toContain("minHeight: 36");
    expect(sheet).toContain("focusedMinHeight: 36");
    expect(sheet).toContain("width:calc(100% - 48px)");
    expect(sheet).toContain("margin:8px 16px calc(env(safe-area-inset-bottom) + 2px)");
    expect(sheet).toContain("min-height:48px");
    expect(sheet).toContain(".comment-composer:focus-within{width:calc(100% - 32px);min-height:76px");
    expect(sheet).toContain("max-height:108px");
    expect(sheet).toContain("border-radius:24px");
    expect(sheet).toContain('class="comment-icon-button image-button"');
    expect(sheet).toContain('class="comment-icon-button send-button"');
    expect(sheet).toContain('<path d="M12 5v14M5 12h14"/>');
    expect(sheet).toContain("width:44px;height:44px");
    expect(sheet).toContain("margin:-5px");
    expect(sheet).toContain(".send-button .send-visual{background:#0f1419}");
    expect(sheet).toContain(".send-button .send-visual svg{width:18px;height:18px}");
    expect(sheet).toContain('class="comment-actions"');
    expect(sheet).toContain(".comment-actions{display:contents}");
    expect(sheet).toContain(".comment-composer:focus-within .comment-actions{display:flex");
    expect(sheet).toContain("grid-template-rows:auto 34px");
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
