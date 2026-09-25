import type { InboxItem } from "@/stores/messages";

type DirectMessageStateOwner = {
  canonicalMessageAdded(accountPubkey: string, item: InboxItem): void;
  authorizationChanged(accountPubkey: string): void;
};

let owner: DirectMessageStateOwner | null = null;

export function registerDirectMessageStateOwner(nextOwner: DirectMessageStateOwner) {
  owner = nextOwner;
}

export function notifyCanonicalMessageAdded(accountPubkey: string, item: InboxItem) {
  owner?.canonicalMessageAdded(accountPubkey, item);
}

export function notifyDirectMessageAuthorizationChanged(accountPubkey: string) {
  owner?.authorizationChanged(accountPubkey);
}
