export type MainPrivateSpaceTab = "saved" | "note" | "todo";

// Navigation preference only: no private content or account data is persisted.
const lastTabByAccount = new Map<string, MainPrivateSpaceTab>();

export function getPrivateSpaceTab(account: string): MainPrivateSpaceTab {
  return lastTabByAccount.get(account.toLowerCase()) || "saved";
}

export function rememberPrivateSpaceTab(account: string, tab: MainPrivateSpaceTab) {
  if (!account) return;
  lastTabByAccount.set(account.toLowerCase(), tab);
}
