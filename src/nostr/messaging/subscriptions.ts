import { GIFT_WRAP_KIND, RUMOR_KIND, NIP04_KIND, LEGACY_MESSAGE_KIND, LEGACY_INTERACTION_KIND } from "./protocol";

// NIP-17 deliberately randomizes wrapper timestamps up to two days into the past.
export const GIFT_WRAP_TIMESTAMP_SKEW_SECONDS = 2 * 24 * 60 * 60;

export function buildMessageSubscriptions(accountPubkey: string, authors: string[], since: number, until?: number) {
  const time = { since, ...(until === undefined ? {} : { until }) };
  const giftWrapTime = {
    since: Math.max(0, since - GIFT_WRAP_TIMESTAMP_SKEW_SECONDS),
    ...(until === undefined ? {} : { until })
  };
  return [
    { kinds: [GIFT_WRAP_KIND], "#p": [accountPubkey], ...giftWrapTime },
    { kinds: [RUMOR_KIND, NIP04_KIND], "#p": [accountPubkey], ...time },
    { kinds: [LEGACY_MESSAGE_KIND], authors, ...time }
  ];
}

export function buildInteractionSubscriptions(accountPubkey: string, since: number, until?: number) {
  const time = { since, ...(until === undefined ? {} : { until }) };
  return [
    { kinds: [LEGACY_INTERACTION_KIND], "#p": [accountPubkey], ...time },
    { kinds: [LEGACY_INTERACTION_KIND], authors: [accountPubkey], ...time }
  ];
}
