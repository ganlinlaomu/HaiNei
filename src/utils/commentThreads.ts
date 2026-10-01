import type { Comment } from "@/stores/interactions";

export type CommentThread = { root: Comment; replies: Comment[] };

export function buildCommentThreads(comments: Comment[]): CommentThread[] {
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  type RootResolution = { rootId: string; kind: "normal" | "orphan" | "cycle" };
  const rootCache = new Map<string, RootResolution>();

  const resolveRoot = (comment: Comment): RootResolution => {
    const cached = rootCache.get(comment.id);
    if (cached) return cached;

    const path: Comment[] = [];
    const pathIndex = new Map<string, number>();
    let current = comment;

    while (true) {
      const known = rootCache.get(current.id);
      if (known) {
        if (known.kind === "orphan") {
          // Preserve the previous missing-parent behavior: every descendant of
          // an orphan chain becomes its own root instead of being grouped under
          // the first locally available orphan.
          for (const node of path) rootCache.set(node.id, { rootId: node.id, kind: "orphan" });
        } else {
          for (const node of path) rootCache.set(node.id, known);
        }
        break;
      }

      pathIndex.set(current.id, path.length);
      path.push(current);
      const parentId = current.parentCommentId;

      if (!parentId) {
        const resolved: RootResolution = { rootId: current.id, kind: "normal" };
        for (const node of path) rootCache.set(node.id, resolved);
        break;
      }

      const parent = byId.get(parentId);
      if (!parent) {
        for (const node of path) rootCache.set(node.id, { rootId: node.id, kind: "orphan" });
        break;
      }

      const cycleIndex = pathIndex.get(parent.id);
      if (cycleIndex !== undefined) {
        const cycle = path.slice(cycleIndex);
        if (cycle.length === 1) {
          rootCache.set(cycle[0].id, { rootId: cycle[0].id, kind: "cycle" });
        } else {
          for (let index = 0; index < cycle.length; index += 1) {
            rootCache.set(cycle[index].id, {
              rootId: cycle[(index - 1 + cycle.length) % cycle.length].id,
              kind: "cycle"
            });
          }
        }
        const entryResolution = rootCache.get(cycle[0].id)!;
        for (let index = 0; index < cycleIndex; index += 1) {
          rootCache.set(path[index].id, entryResolution);
        }
        break;
      }

      current = parent;
    }

    return rootCache.get(comment.id)!;
  };

  const roots: Comment[] = [];
  const repliesByRoot = new Map<string, Comment[]>();
  for (const comment of comments) {
    const rootId = resolveRoot(comment).rootId;
    if (rootId === comment.id) {
      roots.push(comment);
      continue;
    }
    const replies = repliesByRoot.get(rootId);
    if (replies) replies.push(comment);
    else repliesByRoot.set(rootId, [comment]);
  }

  return roots.map(root => ({
    root,
    replies: repliesByRoot.get(root.id) || []
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

export const COMMENT_SHEET_DRAG_START_DISTANCE = 10;
export const COMMENT_SHEET_FLICK_MIN_DISTANCE = 48;
const COMMENT_SHEET_DRAG_DIRECTION_RATIO = 1.15;
const COMMENT_SHEET_SCROLL_TOP_TOLERANCE = 1;

export type CommentSheetDragPhase = "pending" | "dragging" | "native";
export type CommentSheetDragGesture = {
  phase: CommentSheetDragPhase;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startedAt: number;
  panelHeight: number;
};

export function canStartCommentSheetBodyDrag(options: {
  commentCount: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  interactiveTarget: boolean;
  pointerCount?: number;
}) {
  if (options.interactiveTarget || (options.pointerCount ?? 1) !== 1) return false;
  // Comment count is intentionally not the arbiter: short populated lists and
  // the empty state should both be draggable. Scroll geometry decides whether
  // native scrolling still owns the gesture.
  void options.commentCount;
  const scrollable = options.scrollHeight > options.clientHeight + COMMENT_SHEET_SCROLL_TOP_TOLERANCE;
  return !scrollable || options.scrollTop <= COMMENT_SHEET_SCROLL_TOP_TOLERANCE;
}

export function createCommentSheetDragGesture(
  startX: number,
  startY: number,
  startedAt: number,
  panelHeight: number,
  phase: CommentSheetDragPhase = "pending",
): CommentSheetDragGesture {
  return {
    phase,
    startX,
    startY,
    lastX: startX,
    lastY: startY,
    startedAt,
    panelHeight: Math.max(1, panelHeight),
  };
}

export function updateCommentSheetDragGesture(
  gesture: CommentSheetDragGesture,
  clientX: number,
  clientY: number,
  scrollTop = 0,
) {
  const next = { ...gesture, lastX: clientX, lastY: clientY };
  if (next.phase === "native") return { gesture: next, dragDistance: 0, preventDefault: false };

  const deltaX = clientX - next.startX;
  const deltaY = clientY - next.startY;

  if (next.phase === "pending") {
    if (Math.hypot(deltaX, deltaY) < COMMENT_SHEET_DRAG_START_DISTANCE) {
      return { gesture: next, dragDistance: 0, preventDefault: false };
    }
    const downward = deltaY > 0 && deltaY > Math.abs(deltaX) * COMMENT_SHEET_DRAG_DIRECTION_RATIO;
    if (scrollTop > COMMENT_SHEET_SCROLL_TOP_TOLERANCE || !downward) {
      next.phase = "native";
      return { gesture: next, dragDistance: 0, preventDefault: false };
    }
    next.phase = "dragging";
  }

  return {
    gesture: next,
    dragDistance: Math.max(0, deltaY),
    preventDefault: true,
  };
}

export function shouldCloseCommentSheetDrag(
  distance: number,
  panelHeight: number,
  durationMs: number,
  horizontalDistance = 0,
) {
  const vertical = Math.max(0, distance);
  const horizontal = Math.abs(horizontalDistance);
  if (vertical < COMMENT_SHEET_DRAG_START_DISTANCE
    || vertical <= horizontal * COMMENT_SHEET_DRAG_DIRECTION_RATIO) return false;
  const velocity = durationMs > 0 ? vertical / durationMs : 0;
  return vertical > panelHeight * 0.25
    || (vertical >= COMMENT_SHEET_FLICK_MIN_DISTANCE && velocity >= 0.7);
}

export function finishCommentSheetDragGesture(
  gesture: CommentSheetDragGesture,
  endedAt: number,
  cancelled = false,
): "close" | "rebound" | "none" | "cancel" {
  if (cancelled) return "cancel";
  if (gesture.phase !== "dragging") return "none";
  const distance = Math.max(0, gesture.lastY - gesture.startY);
  const horizontalDistance = gesture.lastX - gesture.startX;
  return shouldCloseCommentSheetDrag(
    distance,
    gesture.panelHeight,
    Math.max(0, endedAt - gesture.startedAt),
    horizontalDistance,
  ) ? "close" : "rebound";
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
