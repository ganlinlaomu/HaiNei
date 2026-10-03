export type MentionCandidate = {
  pubkey: string;
  label: string;
  secondary?: string;
  searchText?: string;
};

export type MentionQuery = {
  start: number;
  end: number;
  query: string;
};

export type KnownMention = {
  pubkey: string;
  labels: string[];
};

export type MentionTextSegment =
  | { type: "text"; text: string }
  | { type: "mention"; text: string; label: string; pubkey: string };

export const HAI_NEI_MENTION_TAG = "hainei-mention";

export function mentionTags(pubkeys: readonly string[]) {
  return [...new Set(pubkeys.map(value => value.trim().toLowerCase()))]
    .filter(value => /^[0-9a-f]{64}$/.test(value))
    .map(value => [HAI_NEI_MENTION_TAG, value]);
}

export function mentionedPubkeysFromTags(tags: readonly string[][] | undefined) {
  if (!tags?.length) return [];
  return [...new Set(tags
    .filter(tag => tag[0] === HAI_NEI_MENTION_TAG && /^[0-9a-f]{64}$/i.test(tag[1] || ""))
    .map(tag => tag[1].toLowerCase()))];
}

function isWordLike(char: string) {
  return !!char && /[\p{L}\p{N}_]/u.test(char);
}

export function mentionQueryAtCursor(text: string, cursor: number): MentionQuery | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, safeCursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && isWordLike(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/[\s@]/u.test(query)) return null;
  return { start: at, end: safeCursor, query };
}

export function insertMention(
  text: string,
  range: MentionQuery,
  candidate: Pick<MentionCandidate, "label">,
) {
  const label = candidate.label.trim();
  const insertion = `@${label} `;
  return {
    text: `${text.slice(0, range.start)}${insertion}${text.slice(range.end)}`,
    cursor: range.start + insertion.length,
  };
}

export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  limit = 6,
) {
  const needle = query.normalize("NFKC").toLocaleLowerCase();
  const seen = new Set<string>();
  const result: MentionCandidate[] = [];
  for (const candidate of candidates) {
    const pubkey = candidate.pubkey.trim().toLowerCase();
    const label = candidate.label.trim();
    if (!/^[0-9a-f]{64}$/i.test(pubkey) || !label || seen.has(pubkey)) continue;
    const haystack = [label, candidate.secondary || "", candidate.searchText || "", pubkey]
      .join(" ")
      .normalize("NFKC")
      .toLocaleLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    seen.add(pubkey);
    result.push({ ...candidate, pubkey, label });
    if (result.length >= limit) break;
  }
  return result;
}

function hasMentionBoundary(text: string, start: number, tokenLength: number) {
  const previous = start > 0 ? text[start - 1] : "";
  const next = text[start + tokenLength] || "";
  if (previous && isWordLike(previous)) return false;
  return !isWordLike(next);
}

export function splitKnownMentions(text: string, known: readonly KnownMention[]): MentionTextSegment[] {
  if (!text || !known.length || !text.includes("@")) return [{ type: "text", text }];

  const tokens = known
    .flatMap(item => item.labels
      .map(label => label.trim())
      .filter(Boolean)
      .map(label => ({ pubkey: item.pubkey.toLowerCase(), label, token: `@${label}` })))
    .filter((item, index, all) =>
      /^[0-9a-f]{64}$/i.test(item.pubkey)
      && all.findIndex(other => other.pubkey === item.pubkey && other.label === item.label) === index)
    .sort((a, b) => b.token.length - a.token.length);

  if (!tokens.length) return [{ type: "text", text }];

  const segments: MentionTextSegment[] = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "@") {
      index += 1;
      continue;
    }
    const match = tokens.find(item =>
      text.startsWith(item.token, index) && hasMentionBoundary(text, index, item.token.length));
    if (!match) {
      index += 1;
      continue;
    }
    if (index > plainStart) segments.push({ type: "text", text: text.slice(plainStart, index) });
    segments.push({ type: "mention", text: match.token, label: match.label, pubkey: match.pubkey });
    index += match.token.length;
    plainStart = index;
  }
  if (plainStart < text.length) segments.push({ type: "text", text: text.slice(plainStart) });
  return segments.length ? segments : [{ type: "text", text }];
}
