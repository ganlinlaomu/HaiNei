import type { CanonicalMessage } from "@/nostr/messaging/protocol";

export const DM_RECEIPT_TYPE = "hainei-dm-receipt";
export type DmReceiptStatus = "delivered" | "read";

export type DmReceiptCursor = {
  createdAt: number;
  messageId: string;
};

export type DmReceiptPayload = {
  type: typeof DM_RECEIPT_TYPE;
  status: DmReceiptStatus;
  upTo: DmReceiptCursor;
  /** A per-message read acknowledgement. Never advances the cumulative read cursor. */
  exact?: true;
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
    const createdAt = Number(parsed.upTo?.createdAt);
    const messageId = String(parsed.upTo?.messageId || "").toLowerCase();
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || !EVENT_ID_RE.test(messageId)) return null;
    return {
      type: DM_RECEIPT_TYPE,
      status: parsed.status,
      upTo: { createdAt, messageId },
      ...(parsed.exact === true ? { exact: true as const } : {}),
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
  if (next.createdAt !== current.createdAt) return next.createdAt > current.createdAt;
  return next.messageId.localeCompare(current.messageId) > 0;
}

export function cursorCovers(cursor: DmReceiptCursor | undefined, message: { id: string; created_at: number }) {
  if (!cursor || !EVENT_ID_RE.test(message.id)) return false;
  if (message.created_at !== cursor.createdAt) return message.created_at < cursor.createdAt;
  return message.id.localeCompare(cursor.messageId) <= 0;
}

export function serializeDmReceipt(status: DmReceiptStatus, upTo: DmReceiptCursor) {
  return JSON.stringify({ type: DM_RECEIPT_TYPE, status, upTo } satisfies DmReceiptPayload);
}

/** Read acknowledgement for one explicitly opened temporary message.
 * A normal read cursor would falsely mark earlier unopened temporary DMs read. */
export function serializeExactDmReadReceipt(upTo: DmReceiptCursor) {
  return JSON.stringify({ type: DM_RECEIPT_TYPE, status: "read", exact: true, upTo } satisfies DmReceiptPayload);
}
