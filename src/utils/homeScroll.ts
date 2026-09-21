const memory = new Map<string, number>();

export function homeScrollKey(account?: string | null) {
  const normalized = account?.trim().toLowerCase();
  return normalized ? `hainei_home_scroll_${normalized}` : null;
}

export function saveHomeScroll(account: string | null | undefined, scrollTop: number) {
  const key = homeScrollKey(account);
  if (!key) return;
  const value = Math.max(0, Math.round(scrollTop));
  memory.set(key, value);
  try { sessionStorage.setItem(key, String(value)); } catch {}
}

export function loadHomeScroll(account?: string | null) {
  const key = homeScrollKey(account);
  if (!key) return 0;
  if (memory.has(key)) return memory.get(key) || 0;
  try { return Math.max(0, Number(sessionStorage.getItem(key)) || 0); } catch { return 0; }
}
