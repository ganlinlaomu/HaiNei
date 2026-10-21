import type { CanonicalMessage, DecodeContext } from "@/nostr/messaging/protocol";

export const SYNC_OVERLAP_SECONDS = 30;
// A page shorter than the requested limit is read as "no older events", so the
// limit must not exceed what a relay will return: the managed relay caps a
// REQ at 250, and a 500 request silently ended its catch-up at 250.
export const CATCHUP_PAGE_LIMIT = 250;
// A new installation has no trustworthy cursor. Fetch a bounded snapshot from
// the beginning of relay retention so devices first opened on different days
// converge on the same recent history instead of receiving different 3-day windows.
// Same coverage per wake as the earlier 4 pages of 500.
export const INITIAL_HISTORY_MAX_BATCHES = 8;
// A received_since cursor is in this device's clock but compared with the
// relay's. Re-reading the last half hour absorbs clock skew and the relay's
// 10-minute future-timestamp tolerance; repeats are skipped as already stored.
export const RECEIVED_CURSOR_MARGIN_SECONDS = 30 * 60;
export const RESUME_MAX_BATCHES = 2;
export const MAX_FUTURE_SKEW_SECONDS = 5 * 60;

export type MessageSource = "history" | "realtime" | "reconnect" | "resume" | "manual" | "local-migration";
export type SyncStatus = "idle" | "connecting" | "catching-up" | "live" | "offline" | "error";
export type MessageAuthorizationDecision = "accepted" | "rejected" | "unresolved";
export type MessageDeliveryResult = boolean | "defer" | void;

export type MessageIngestionMetadata = {
  durable?: boolean;
  source: MessageSource;
  relayUrl?: string;
};
export type SubscriptionLike = {
  on(eventName: string, callback: (...args: any[]) => void): void;
  close?: () => void;
  unsub?: () => void;
  unsubscribe?: () => void;
};

export type MessageSyncOptions = {
  accountPubkey: string;
  relays: string[];
  authors: string[];
  decodeContext: DecodeContext;
  onMessage?: (message: CanonicalMessage, metadata: MessageIngestionMetadata) => MessageDeliveryResult | Promise<MessageDeliveryResult>;
  onPersistedMessage?: (message: CanonicalMessage, metadata: MessageIngestionMetadata, inserted: boolean) => void | Promise<void>;
  onStatus?: (status: SyncStatus) => void;
  /** Distinct from a working realtime connection: history may be incomplete. */
  onCatchupStatus?: (status: "settled" | "pending") => void;
  /** Relay to catch up from first (the managed relay is far faster to page). */
  preferredCatchupRelay?: () => string;
  /** The preferred relay finished its catch-up window; others may still be paging. */
  onPreferredRelayCaughtUp?: () => void;
  /**
   * Relay that supports the `received_since` filter extension, or "". With a
   * cursor it is caught up by arrival time instead of re-reading the NIP-59
   * two-day backdating window.
   */
  receivedSinceRelay?: () => Promise<string>;
  /**
   * Relay work (realtime replay window and history catch-up) waits for this.
   * Push-delivered messages and the local replay do not, so a notification
   * opened on a cold start shows immediately.
   */
  historyGate?: Promise<unknown>;
};
