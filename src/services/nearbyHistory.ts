import { db } from "@/db/dexie";
import { isLocalVaultUnlocked, openLocalVaultBytes, sealLocalVaultBytes } from "@/services/localVault";
import type { NearbyTransferRecord } from "@/services/nearbySession";

/**
 * Encrypted 文件传输助手 history. Records and received files are sealed with
 * the account's local vault key, so nothing is readable while locked or after
 * switching accounts. Outgoing files are not copied: the sender still has them.
 */

export const NEARBY_HISTORY_DAYS = 7;
const RETENTION_MS = NEARBY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
/** Newest records kept; the in-memory transfer list is capped at 100. */
export const NEARBY_HISTORY_MAX_RECORDS = 50;
/** Bounds memory while sealing or opening one slice. */
const PART_BYTES = 4 * 1024 * 1024;
const PURPOSE = "nearby-transfer";

export type StoredTransfer = Pick<NearbyTransferRecord,
  "id" | "kind" | "direction" | "peerName" | "peerDevice" | "localDeviceName" | "createdAt"
  | "files" | "text" | "state" | "saveState" | "stored">;

export function canStoreHistory(account: string) {
  return !!account && isLocalVaultUnlocked(account);
}

export function toStored(record: NearbyTransferRecord): StoredTransfer {
  const { id, kind, direction, peerName, peerDevice, localDeviceName, createdAt, files, text, state, saveState, stored } = record;
  return JSON.parse(JSON.stringify({ id, kind, direction, peerName, peerDevice, localDeviceName, createdAt, files, text, state, saveState, stored }));
}

export async function putHistoryRecord(account: string, record: StoredTransfer) {
  if (!canStoreHistory(account)) return;
  await db.transferRecords.put({ accountPubkey: account, id: record.id, createdAt: record.createdAt || Date.now(), record });
}

/** Seal one received file slice by slice. */
export async function putHistoryFile(account: string, recordId: string, index: number, file: File) {
  if (!canStoreHistory(account)) return false;
  for (let part = 0, offset = 0; part === 0 || offset < file.size; part++, offset += PART_BYTES) {
    const plain = await file.slice(offset, offset + PART_BYTES).arrayBuffer();
    const size = plain.byteLength;
    const key = `${recordId}:${index}:${part}`;
    const sealed = await sealLocalVaultBytes(account, PURPOSE, key, file.type, plain);
    new Uint8Array(plain).fill(0);
    await db.transferFileParts.put({ accountPubkey: account, key, recordId, index, part, size, mime: file.type, iv: sealed.iv, bytes: sealed.bytes });
  }
  return true;
}

export async function loadHistoryFile(account: string, recordId: string, index: number, name: string, type: string) {
  const parts = (await db.transferFileParts.where("[accountPubkey+recordId]").equals([account, recordId]).toArray())
    .filter(part => part.index === index)
    .sort((a, b) => a.part - b.part);
  if (!parts.length) return null;
  const blobs: Blob[] = [];
  for (const part of parts) {
    const plain = await openLocalVaultBytes(account, PURPOSE, part.key, part.mime, part.size, part.iv, part.bytes);
    blobs.push(new Blob([plain]));
    new Uint8Array(plain).fill(0);
  }
  return new File(blobs, name, { type });
}

export async function deleteHistory(account: string, ids: string[]) {
  if (!account || !ids.length) return;
  await db.transaction("rw", db.transferRecords, db.transferFileParts, async () => {
    await db.transferRecords.bulkDelete(ids.map(id => [account, id] as [string, string]));
    for (const id of ids) await db.transferFileParts.where("[accountPubkey+recordId]").equals([account, id]).delete();
  });
}

/** Drop expired and overflow records, then return the rest newest first. */
export async function loadHistory(account: string, now = Date.now()) {
  if (!canStoreHistory(account)) return [];
  const rows = await db.transferRecords.where("accountPubkey").equals(account).toArray();
  rows.sort((a, b) => b.createdAt - a.createdAt);
  const keep = rows.filter(row => now - row.createdAt < RETENTION_MS).slice(0, NEARBY_HISTORY_MAX_RECORDS);
  const kept = new Set(keep.map(row => row.id));
  await deleteHistory(account, rows.filter(row => !kept.has(row.id)).map(row => row.id));
  return keep.map(row => row.record as StoredTransfer);
}
