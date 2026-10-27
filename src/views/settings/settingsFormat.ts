/** Absolute local time for a millisecond timestamp, or a dash. */
export function formatTimestamp(timestamp?: number) {
  return timestamp ? new Date(timestamp).toLocaleString() : "—";
}

/** "12s 前" style age for a timestamp in seconds or milliseconds. */
export function formatRelativeTimestamp(timestamp?: number) {
  if (!timestamp) return "—";
  const ms = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  return new Date(ms).toLocaleDateString();
}
