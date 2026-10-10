/** Preview text only. Never truncate the underlying encrypted DM content. */
const MAX_QUOTE_PREVIEW_CODEPOINTS = 160;

export function quotedMessageExcerpt(text: string): string {
  if (text.length <= MAX_QUOTE_PREVIEW_CODEPOINTS) return text;
  // At most two UTF-16 units per code point. Inspect only a bounded prefix,
  // and never split a surrogate pair (common in emoji / mobile chats).
  const prefix = Array.from(text.slice(0, MAX_QUOTE_PREVIEW_CODEPOINTS * 2 + 1));
  if (prefix.length <= MAX_QUOTE_PREVIEW_CODEPOINTS) return text;
  return prefix.slice(0, MAX_QUOTE_PREVIEW_CODEPOINTS).join("") + "…";
}
