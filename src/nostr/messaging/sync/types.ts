import type { CanonicalMessage, DecodeContext } from "@/nostr/messaging/protocol";

export const SYNC_OVERLAP_SECONDS = 30;
export const INITIAL_SYNC_WINDOW_SECONDS = 3 * 24 * 60 * 60;
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
  onMessage?: (message: CanonicalMessage, metadata: MessageIngestionMetadata) => void | Promise<void>;
  onStatus?: (status: SyncStatus) => void;
};
