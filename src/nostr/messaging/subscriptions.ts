import { GIFT_WRAP_KIND } from "./protocol";

// NIP-17 deliberately randomizes wrapper timestamps up to two days into the past.
export const GIFT_WRAP_TIMESTAMP_SKEW_SECONDS = 2 * 24 * 60 * 60;

export function buildMessageSubscriptions(accountPubkey: string, _authors: string[], since: number, until?: number) {
  const giftWrapTime = {
    since: Math.max(0, since - GIFT_WRAP_TIMESTAMP_SKEW_SECONDS),
    ...(until === undefined ? {} : { until })
  };
  return [{ kinds: [GIFT_WRAP_KIND], "#p": [accountPubkey], ...giftWrapTime }];
}
