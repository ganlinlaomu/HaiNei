import type { Comment } from "@/stores/interactions";

export type CommentThread = { root: Comment; replies: Comment[] };

export function buildCommentThreads(comments: Comment[]): CommentThread[] {
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const rootIdFor = (comment: Comment) => {
    let current = comment;
    const visited = new Set([comment.id]);
    while (current.parentCommentId) {
      const parent = byId.get(current.parentCommentId);
      if (!parent || visited.has(parent.id)) break;
      visited.add(parent.id);
      current = parent;
    }
    return current.parentCommentId && !byId.has(current.parentCommentId) ? comment.id : current.id;
  };

  const roots = comments.filter(comment => rootIdFor(comment) === comment.id);
  return roots.map(root => ({
    root,
    replies: comments.filter(comment => comment.id !== root.id && rootIdFor(comment) === root.id)
  }));
}

export function commentCountIncludingReplies(comments: Comment[]) {
  return comments.length;
}

export function buildCommentSubmission(
  messageId: string,
  postAuthor: string,
  text: string,
  replyTarget?: Pick<Comment, "id" | "author"> | null,
  currentPubkey?: string
) {
  const recipientPubkey = replyTarget
    ? (currentPubkey && replyTarget.author === currentPubkey ? postAuthor : replyTarget.author)
    : postAuthor;
  return {
    messageId,
    recipientPubkey,
    text: text.trim(),
    parentCommentId: replyTarget?.id
  };
}

export function shouldCloseCommentSheetDrag(distance: number, panelHeight: number, durationMs: number) {
  const velocity = durationMs > 0 ? distance / durationMs : 0;
  return distance > panelHeight * 0.25 || velocity >= 0.7;
}

export function canSubmitComment(text: string, hasImage: boolean) {
  return text.trim().length > 0 || hasImage;
}

export function commentDraftAfterSend(draft: string, succeeded: boolean) {
  return succeeded ? "" : draft;
}

export function feedScrollAfterSheetClose(originalScrollTop: number) {
  return originalScrollTop;
}
