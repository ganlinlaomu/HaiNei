import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { messageOrderAt, normalizeMillis } from "@/nostr/messaging/sync/sorting";

export const DM_RECEIPT_TYPE = "hainei-dm-receipt";
export type DmReceiptStatus = "delivered" | "read";

export type DmReceiptCursor = {
  createdAt: number;
  messageId: string;
  /** Sub-second part of the acknowledged message's order key; absent from older clients. */
  ms?: number;
};

export type DmReceiptPayload = {
  type: typeof DM_RECEIPT_TYPE;
  status: DmReceiptStatus;
  upTo: DmReceiptCursor;
  /** A per-message read acknowledgement. Never advances the cumulative read cursor. */
  exact?: true;
  /** Absolute read-open deletion deadline (ms) for an exact temporary DM. */
  deadlineAt?: number;
};

const EVENT_ID_RE = /^[0-9a-f]{64}$/i;

export function dmReceiptTags(status: DmReceiptStatus): string[][] {
  return [["t", DM_RECEIPT_TYPE], ["status", status]];
}

export function isDmReceiptMessage(message: Pick<CanonicalMessage, "tags">) {
  return message.tags?.some(tag => tag[0] === "t" && tag[1] === DM_RECEIPT_TYPE) === true;
}

export function decodeDmReceiptPayload(plaintext: string | undefined): DmReceiptPayload | null {
  if (!plaintext) return null;
  try {
    const parsed = JSON.parse(plaintext) as Partial<DmReceiptPayload>;
    if (parsed.type !== DM_RECEIPT_TYPE || (parsed.status !== "delivered" && parsed.status !== "read")) return null;
    if (parsed.exact !== undefined && (parsed.exact !== true || parsed.status !== "read")) return null;
    if (parsed.deadlineAt !== undefined && (parsed.exact !== true
      || !Number.isSafeInteger(parsed.deadlineAt) || Number(parsed.deadlineAt) <= 0)) return null;
    const createdAt = Number(parsed.upTo?.createdAt);
    const messageId = String(parsed.upTo?.messageId || "").toLowerCase();
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || !EVENT_ID_RE.test(messageId)) return null;
    const ms = normalizeMillis(parsed.upTo?.ms);
    return {
      type: DM_RECEIPT_TYPE,
      status: parsed.status,
      upTo: { createdAt, messageId, ...(ms === undefined ? {} : { ms }) },
      ...(parsed.exact === true ? { exact: true as const } : {}),
      ...(parsed.deadlineAt === undefined ? {} : { deadlineAt: Number(parsed.deadlineAt) }),
    };
  } catch {
    return null;
  }
}

export function isDmReceiptPayload(plaintext: string | undefined) {
  return decodeDmReceiptPayload(plaintext) !== null;
}

export function decodeDmReceipt(message: Pick<CanonicalMessage, "plaintext" | "tags">): DmReceiptPayload | null {
  if (!isDmReceiptMessage(message)) return null;
  return decodeDmReceiptPayload(message.plaintext);
}

export function cursorAfter(next: DmReceiptCursor, current?: DmReceiptCursor | null) {
  if (!current) return true;
  const precise = next.ms !== undefined && current.ms !== undefined;
  const nextOrder = precise ? next.createdAt * 1000 + next.ms! : next.createdAt;
  const currentOrder = precise ? current.createdAt * 1000 + current.ms! : current.createdAt;
  if (nextOrder !== currentOrder) return nextOrder > currentOrder;
  return next.messageId.localeCompare(current.messageId) > 0;
}

/** Whether a receipt cursor acknowledges `message`, using the same (orderAt, id) key as display order. */
export function cursorCovers(
  cursor: DmReceiptCursor | undefined,
  message: { id: string; created_at: number; tags?: string[][] },
) {
  if (!cursor || !EVENT_ID_RE.test(message.id)) return false;
  const messageOrder = cursor.ms === undefined ? message.created_at : messageOrderAt(message.created_at, message.tags);
  const cursorOrder = cursor.ms === undefined ? cursor.createdAt : cursor.createdAt * 1000 + cursor.ms;
  if (messageOrder !== cursorOrder) return messageOrder < cursorOrder;
  return message.id.localeCompare(cursor.messageId) <= 0;
}

export function serializeDmReceipt(status: DmReceiptStatus, upTo: DmReceiptCursor) {
  return JSON.stringify({ type: DM_RECEIPT_TYPE, status, upTo } satisfies DmReceiptPayload);
}

/** Read acknowledgement for one explicitly opened temporary message.
 * A normal read cursor would falsely mark earlier unopened temporary DMs read. */
export function serializeExactDmReadReceipt(upTo: DmReceiptCursor, deadlineAt?: number) {
  if (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)) {
    throw new Error("invalid_temporary_read_deadline");
  }
  return JSON.stringify({
    type: DM_RECEIPT_TYPE, status: "read", exact: true, upTo,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  } satisfies DmReceiptPayload);
}
