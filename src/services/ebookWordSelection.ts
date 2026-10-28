import { normalizeSelection } from "@/services/ebookDictionary";

/** Locate a single English word at an insertion point in a text node. */
export function wordAtTextOffset(text: string, offset: number): { word: string; start: number; end: number } | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return null;
  const pattern = /[a-z]+(?:['\u2019-][a-z]+)*/gi;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset < start || offset > end) continue;
    const word = normalizeSelection(match[0]);
    return word ? { word, start, end } : null;
  }
  return null;
}

/**
 * Resolve a tap in the EPUB iframe without inserting scripts or modifying
 * publisher HTML. WebKit uses caretRangeFromPoint; newer browsers expose
 * the standard caretPositionFromPoint.
 */
export function wordAtPoint(doc: Document, x: number, y: number): string | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const caretDocument = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = caretDocument.caretPositionFromPoint?.(x, y);
  const oldCaret = caret ? null : caretDocument.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? oldCaret?.startContainer;
  const offset = caret?.offset ?? oldCaret?.startOffset;
  if (node?.nodeType !== 3 || offset === undefined) return null;
  const hit = wordAtTextOffset(node.textContent || "", offset);
  if (!hit) return null;
  const wordRange = doc.createRange();
  wordRange.setStart(node, hit.start);
  wordRange.setEnd(node, hit.end);
  // A tap in margins must not resolve to the nearest distant text node.
  const withinWord = Array.from(wordRange.getClientRects()).some(rect =>
    x >= rect.left - 8 && x <= rect.right + 8 &&
    y >= rect.top - 8 && y <= rect.bottom + 8
  );
  return withinWord ? hit.word : null;
}
