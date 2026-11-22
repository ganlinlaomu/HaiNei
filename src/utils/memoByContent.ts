/**
 * Memoize a pure function of a message's content string.
 *
 * The chat template derives a row's kind and text from its content several
 * times per row on every render (text, caption, audio, file, location, …),
 * and each derivation parses the content again. With 300 rendered rows one
 * insertion of older messages spent ~2 s in these parsers on the Pi.
 * Content never changes for a given string, so the result can be reused.
 *
 * Bounded: the oldest entry is dropped past `capacity`. Callers must treat
 * returned objects as read-only, since they are shared between calls.
 */
export function memoByContent<T>(fn: (content: string) => T, capacity = 2_000) {
  const cache = new Map<string, T>();
  return (content: string): T => {
    if (cache.has(content)) return cache.get(content) as T;
    const value = fn(content);
    cache.set(content, value);
    if (cache.size > capacity) cache.delete(cache.keys().next().value as string);
    return value;
  };
}
