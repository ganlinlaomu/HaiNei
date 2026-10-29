/**
 * Long-press excerpt selection for the EPUB reader.
 *
 * The chapter iframe is script-disabled and covered by a parent-owned tap
 * layer (taps there look words up), so the system's own text selection can
 * never start. Instead the reader resolves touch points to text positions
 * here and draws its own highlight. Positions are offsets into one flat
 * string of the chapter's text, with a "\n" between block elements.
 */

export const MAX_EXCERPT_CHARS = 500;

const STRONG_END = /[。！？!?…]/;
const CLOSING = /["'”’」』）)\]]/;
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
  "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TD", "TH", "TR", "UL", "BR",
]);

export type TextSpan = { start: number; end: number };

function isSpace(char: string | undefined) {
  return char !== undefined && /\s/.test(char);
}

/**
 * Whether offset `j` sits right after a complete sentence end: a terminator
 * (。！？!?… or a "." followed by space) plus any closing quotes.
 */
export function sentenceEndsBefore(text: string, j: number): boolean {
  if (j < text.length && (STRONG_END.test(text[j]) || text[j] === "." || CLOSING.test(text[j]))) return false;
  let k = j;
  while (k > 0 && CLOSING.test(text[k - 1])) k--;
  if (k === 0) return false;
  const char = text[k - 1];
  if (STRONG_END.test(char)) return true;
  return char === "." && (j >= text.length || isSpace(text[j]));
}

/** The sentence around `pos`, never crossing a paragraph. */
export function sentenceBounds(text: string, pos: number): TextSpan {
  const at = Math.max(0, Math.min(text.length, pos));
  let start = at;
  while (start > 0 && text[start - 1] !== "\n" && !sentenceEndsBefore(text, start)) start--;
  let end = at;
  while (end < text.length && text[end] !== "\n") {
    end++;
    if (sentenceEndsBefore(text, end)) break;
  }
  return trimSpan(text, { start, end });
}

export function trimSpan(text: string, span: TextSpan): TextSpan {
  let { start, end } = span;
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  return { start, end };
}

/** Move a drag end to a whole Latin word, so excerpts never cut "acknow|ledged". */
export function snapToWord(text: string, pos: number, forward: boolean): number {
  const word = /[A-Za-z0-9'’-]/;
  let at = Math.max(0, Math.min(text.length, pos));
  if (forward) while (at < text.length && at > 0 && word.test(text[at - 1]) && word.test(text[at])) at++;
  else while (at > 0 && at < text.length && word.test(text[at - 1]) && word.test(text[at])) at--;
  return at;
}

/** The selection spanning the long-pressed sentence and the current finger position. */
export function extendSpan(text: string, anchor: TextSpan, pos: number): TextSpan {
  if (pos >= anchor.end) return trimSpan(text, { start: anchor.start, end: snapToWord(text, pos, true) });
  if (pos <= anchor.start) return trimSpan(text, { start: snapToWord(text, pos, false), end: anchor.end });
  return anchor;
}

/** Grow a selection by one sentence before or after it. */
export function growBySentence(text: string, span: TextSpan, direction: "before" | "after"): TextSpan {
  if (direction === "before") {
    let at = span.start;
    while (at > 0 && isSpace(text[at - 1])) at--;
    if (at === 0) return span;
    return { start: sentenceBounds(text, at - 1).start, end: span.end };
  }
  let at = span.end;
  while (at < text.length && isSpace(text[at])) at++;
  if (at >= text.length) return span;
  return { start: span.start, end: sentenceBounds(text, at).end };
}

/** Normalised excerpt text: paragraphs kept, runs of spaces collapsed. */
export function excerptText(text: string, span: TextSpan): string {
  return text.slice(span.start, span.end)
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export type ExcerptSource = { title?: string; authors?: string[]; chapter?: string };

/** The composer text for an excerpt: quote, source line, then room for thoughts. */
export function formatExcerptPost(excerpt: string, source: ExcerptSource): string {
  const chars = Array.from(excerpt.trim());
  const quoted = chars.length > MAX_EXCERPT_CHARS ? chars.slice(0, MAX_EXCERPT_CHARS).join("") + "…" : chars.join("");
  const parts = [
    source.title?.trim() ? `《${source.title.trim()}》` : "",
    (source.authors || []).map(author => author.trim()).filter(Boolean).slice(0, 2).join("、"),
    source.chapter?.trim() || "",
  ].filter(Boolean);
  return `「${quoted}」\n${parts.length ? "—— " + parts.join(" · ") + "\n" : ""}\n`;
}

type Segment = { node: Text; start: number; end: number };

/** A flat view of a chapter document's text, mapping offsets back to DOM nodes. */
export class ChapterTextIndex {
  readonly text: string;
  private readonly segments: Segment[];

  constructor(private readonly doc: Document) {
    const segments: Segment[] = [];
    let text = "";
    let lastBlock: Element | null = null;
    const body = doc.body || doc.documentElement;
    const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const value = node.data;
      if (!value) continue;
      const parent = node.parentElement;
      if (parent && /^(SCRIPT|STYLE|TITLE|HEAD)$/.test(parent.tagName)) continue;
      let block: Element | null = parent;
      while (block && !BLOCK_TAGS.has(block.tagName.toUpperCase())) block = block.parentElement;
      if (lastBlock && block !== lastBlock && text && !text.endsWith("\n")) text += "\n";
      lastBlock = block;
      segments.push({ node, start: text.length, end: text.length + value.length });
      text += value;
    }
    this.text = text;
    this.segments = segments;
  }

  /** Text offset of the caret under a frame-relative point, or null off text. */
  offsetAtPoint(x: number, y: number): number | null {
    const caretDocument = this.doc as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const caret = caretDocument.caretPositionFromPoint?.(x, y);
    const oldCaret = caret ? null : caretDocument.caretRangeFromPoint?.(x, y);
    const node = caret?.offsetNode ?? oldCaret?.startContainer;
    const offset = caret?.offset ?? oldCaret?.startOffset;
    if (!node || offset === undefined) return null;
    const segment = this.segments.find(item => item.node === node);
    if (segment) return segment.start + Math.min(offset, segment.end - segment.start);
    // A caret between elements: use the first text inside or after it.
    const child = node.childNodes?.[offset];
    if (child) {
      const inside = this.segments.find(item => child === item.node || child.contains?.(item.node));
      if (inside) return inside.start;
    }
    return null;
  }

  private boundary(pos: number, preferEnd: boolean) {
    const segments = this.segments;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (pos < segment.start) return { node: segment.node, offset: 0 };
      if (pos < segment.end || (pos === segment.end && (preferEnd || index === segments.length - 1))) {
        return { node: segment.node, offset: pos - segment.start };
      }
    }
    const last = segments[segments.length - 1];
    return last ? { node: last.node, offset: last.end - last.start } : null;
  }

  range(span: TextSpan): Range | null {
    const start = this.boundary(span.start, false);
    const end = this.boundary(span.end, true);
    if (!start || !end) return null;
    const range = this.doc.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  /** Highlight boxes for a span, in iframe document coordinates. */
  rects(span: TextSpan): Array<{ left: number; top: number; width: number; height: number }> {
    const range = this.range(span);
    if (!range) return [];
    return Array.from(range.getClientRects())
      .filter(rect => rect.width > 0.5 && rect.height > 0.5)
      .slice(0, 400)
      .map(rect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }));
  }
}
