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
  replyTarget?: Pick<Comment, "id" | "author"> | null
) {
  return {
    messageId,
    recipientPubkey: replyTarget?.author || postAuthor,
    text: text.trim(),
    parentCommentId: replyTarget?.id
  };
}

export function commentDraftAfterSend(draft: string, succeeded: boolean) {
  return succeeded ? "" : draft;
}

export function feedScrollAfterSheetClose(originalScrollTop: number) {
  return originalScrollTop;
}
