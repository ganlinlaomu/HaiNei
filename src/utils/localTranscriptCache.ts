const transcriptCache = new Map<string, string>();

export function getCachedTranscript(key: string) {
  return key ? (transcriptCache.get(key) || "") : "";
}

export function setCachedTranscript(key: string, text: string) {
  if (!key) return;
  transcriptCache.set(key, text);
}
