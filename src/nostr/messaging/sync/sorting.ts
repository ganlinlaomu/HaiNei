import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { SYNC_OVERLAP_SECONDS } from "./types";

type ComparableMessage = Pick<CanonicalMessage, "id" | "createdAt">;

export function compareMessages(a: ComparableMessage, b: ComparableMessage): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

export function isMessageAfter(
  message: ComparableMessage,
  cursor?: { lastReadCreatedAt?: number; lastReadMessageId?: string } | null
): boolean {
  if (!cursor?.lastReadCreatedAt) return true;
  if (message.createdAt !== cursor.lastReadCreatedAt) return message.createdAt > cursor.lastReadCreatedAt;
  return message.id.localeCompare(cursor.lastReadMessageId || "") > 0;
}

export function calculateCatchupSince(highWatermark: number | undefined, nowSeconds: number): number {
  return highWatermark
    ? Math.max(0, highWatermark - SYNC_OVERLAP_SECONDS)
    : 0;
}
