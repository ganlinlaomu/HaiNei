import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { SYNC_OVERLAP_SECONDS } from "./types";

/** Rumor tag carrying the sender's sub-second clock: ["ms", "0".."999"]. */
export const MESSAGE_MS_TAG = "ms";

type ComparableMessage = Pick<CanonicalMessage, "id" | "createdAt"> & { tags?: string[][] };

export type ReadCursor = {
  lastReadCreatedAt?: number;
  lastReadMessageId?: string;
  /** Sub-second part of the read message's order key; absent on older cursors. */
  lastReadMs?: number;
};

function validMillis(value: unknown): number {
  const ms = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value)
    : typeof value === "number" ? value : NaN;
  return Number.isInteger(ms) && ms >= 0 && ms <= 999 ? ms : 0;
}

/** Messages without a valid ms tag (older clients) sort at .000 of their second. */
export function messageMillis(tags?: string[][] | null): number {
  const tag = tags?.find(item => item[0] === MESSAGE_MS_TAG);
  return tag ? validMillis(tag[1]) : 0;
}

export function messageOrderAt(createdAt: number, tags?: string[][] | null): number {
  return createdAt * 1000 + messageMillis(tags);
}

/** Accepts 0..999 from a tag string or a stored number; anything else is 0. */
export function normalizeMillis(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return validMillis(value);
}

export function cursorOrderAt(cursor: ReadCursor | null | undefined): number {
  return (cursor?.lastReadCreatedAt || 0) * 1000 + validMillis(cursor?.lastReadMs);
}

/** Order key: (created_at * 1000 + ms, event id). */
export function compareMessages(a: ComparableMessage, b: ComparableMessage): number {
  return messageOrderAt(a.createdAt, a.tags) - messageOrderAt(b.createdAt, b.tags) || a.id.localeCompare(b.id);
}

/** Same as compareMessages for rows shaped like InboxItem (created_at). */
export function compareInboxItems(
  a: { id: string; created_at: number; tags?: string[][] },
  b: { id: string; created_at: number; tags?: string[][] },
): number {
  return messageOrderAt(a.created_at, a.tags) - messageOrderAt(b.created_at, b.tags) || a.id.localeCompare(b.id);
}

export function readCursorFor(message: ComparableMessage): Required<ReadCursor> {
  return {
    lastReadCreatedAt: message.createdAt,
    lastReadMessageId: message.id,
    lastReadMs: messageMillis(message.tags),
  };
}

export function isMessageAfter(message: ComparableMessage, cursor?: ReadCursor | null): boolean {
  if (!cursor?.lastReadCreatedAt) return true;
  if (cursor.lastReadMs === undefined) {
    // Cursors written before ms ordering compare at second granularity.
    if (message.createdAt !== cursor.lastReadCreatedAt) return message.createdAt > cursor.lastReadCreatedAt;
    return message.id.localeCompare(cursor.lastReadMessageId || "") > 0;
  }
  const messageOrder = messageOrderAt(message.createdAt, message.tags);
  const order = cursorOrderAt(cursor);
  if (messageOrder !== order) return messageOrder > order;
  return message.id.localeCompare(cursor.lastReadMessageId || "") > 0;
}

/** True when cursor `next` is strictly later than `current` in (orderAt, id). */
export function isCursorAfter(next: ReadCursor, current?: ReadCursor | null): boolean {
  if (!current?.lastReadCreatedAt) return !!next.lastReadCreatedAt;
  const bothPrecise = next.lastReadMs !== undefined && current.lastReadMs !== undefined;
  const nextOrder = bothPrecise ? cursorOrderAt(next) : (next.lastReadCreatedAt || 0);
  const currentOrder = bothPrecise ? cursorOrderAt(current) : current.lastReadCreatedAt;
  if (nextOrder !== currentOrder) return nextOrder > currentOrder;
  return (next.lastReadMessageId || "").localeCompare(current.lastReadMessageId || "") > 0;
}

export function calculateCatchupSince(highWatermark: number | undefined, nowSeconds: number): number {
  return highWatermark
    ? Math.max(0, highWatermark - SYNC_OVERLAP_SECONDS)
    : 0;
}

let lastIssuedOrderAt = 0;

/**
 * Monotonic local message clock. Two sends in the same millisecond get
 * consecutive values, so the ms tag preserves send order on every device.
 */
export function nextMessageClock(nowMs = Date.now()): { createdAt: number; ms: number } {
  const orderAt = Math.max(Math.floor(nowMs), lastIssuedOrderAt + 1);
  lastIssuedOrderAt = orderAt;
  return { createdAt: Math.floor(orderAt / 1000), ms: orderAt % 1000 };
}

/** Test hook: reset the monotonic clock. */
export function resetMessageClockForTests() {
  lastIssuedOrderAt = 0;
}
