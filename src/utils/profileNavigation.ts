import type { Router } from "vue-router";

function normalized(pubkey: string) {
  return pubkey.trim().toLowerCase();
}

export function profileLocation(accountPubkey: string, ownerPubkey: string) {
  const account = normalized(accountPubkey);
  const owner = normalized(ownerPubkey);
  return owner === account ? "/settings/profile" : `/profile/${owner}`;
}

export function canViewPrivateProfile(
  accountPubkey: string,
  ownerPubkey: string,
  isAccepted: (pubkey: string) => boolean
) {
  const account = normalized(accountPubkey);
  const owner = normalized(ownerPubkey);
  return !!account && !!owner && (owner === account || isAccepted(owner));
}

export function openProfile(
  router: Pick<Router, "push">,
  accountPubkey: string,
  ownerPubkey: string,
  event?: Pick<Event, "stopPropagation">
) {
  event?.stopPropagation();
  return router.push(profileLocation(accountPubkey, ownerPubkey));
}
