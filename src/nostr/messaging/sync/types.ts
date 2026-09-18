import type { CanonicalMessage, DecodeContext } from "@/nostr/messaging/protocol";

export const SYNC_OVERLAP_SECONDS = 30;
// A new installation has no trustworthy cursor. Fetch a bounded snapshot from
// the beginning of relay retention so devices first opened on different days
// converge on the same recent history instead of receiving different 3-day windows.
export const INITIAL_HISTORY_MAX_BATCHES = 4;
export const MAX_FUTURE_SKEW_SECONDS = 5 * 60;

export type MessageSource = "history" | "realtime" | "reconnect" | "resume" | "manual" | "local-migration";
export type SyncStatus = "idle" | "connecting" | "catching-up" | "live" | "offline" | "error";

export type MessageIngestionMetadata = {
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
  onMessage?: (message: CanonicalMessage, metadata: MessageIngestionMetadata) => boolean | void | Promise<boolean | void>;
  onStatus?: (status: SyncStatus) => void;
};
