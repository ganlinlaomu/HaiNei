export function normalizeAccountPubkey(accountPubkey: string): string {
  const normalized = accountPubkey?.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("A valid accountPubkey is required for private storage access");
  }
  return normalized;
}
