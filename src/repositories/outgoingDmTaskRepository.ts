import { db, type HaiNeiDatabase, type OutgoingDmTaskRecord } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

type LegacyPreparedImage = {
  encryptedBlob?: Blob;
  previewBlob?: Blob;
};
type LegacyOutgoingDmTask = OutgoingDmTaskRecord & {
  imageBlob?: Blob;
  preparedImage?: OutgoingDmTaskRecord["preparedImage"] & LegacyPreparedImage;
};

function isReadableBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob && typeof value.arrayBuffer === "function";
}

function cloneBuffer(value: ArrayBuffer) {
  return value.slice(0);
}

function plainOutgoingTask(record: OutgoingDmTaskRecord): OutgoingDmTaskRecord {
  return {
    accountPubkey: record.accountPubkey,
    localId: record.localId,
    peerPubkey: record.peerPubkey,
    text: record.text,
    ...(record.imageBytes ? { imageBytes: cloneBuffer(record.imageBytes) } : {}),
    ...(record.imageName ? { imageName: record.imageName } : {}),
    ...(record.imageType ? { imageType: record.imageType } : {}),
    ...(record.preparedImage ? { preparedImage: {
      encryptedBytes: cloneBuffer(record.preparedImage.encryptedBytes),
      encryptedName: record.preparedImage.encryptedName,
      previewBytes: cloneBuffer(record.preparedImage.previewBytes),
      mime: record.preparedImage.mime,
      iv: record.preparedImage.iv,
      key: record.preparedImage.key,
      width: record.preparedImage.width,
      height: record.preparedImage.height,
    } } : {}),
    ...(record.mediaType ? { mediaType: record.mediaType } : {}),
    ...(record.preparedAudio ? { preparedAudio: {
      encryptedBytes: cloneBuffer(record.preparedAudio.encryptedBytes),
      encryptedName: record.preparedAudio.encryptedName,
      mime: record.preparedAudio.mime,
      iv: record.preparedAudio.iv,
      key: record.preparedAudio.key,
      duration: record.preparedAudio.duration,
      size: record.preparedAudio.size,
    } } : {}),
    ...(record.audioMime ? { audioMime: record.audioMime } : {}),
    ...(record.audioDuration !== undefined ? { audioDuration: record.audioDuration } : {}),
    ...(record.audioSize !== undefined ? { audioSize: record.audioSize } : {}),
    state: record.state,
    ...(record.uploadedRef ? { uploadedRef: record.uploadedRef } : {}),
    ...(record.outgoingId ? { outgoingId: record.outgoingId } : {}),
    ...(record.canonicalMessageId ? { canonicalMessageId: record.canonicalMessageId } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastError ? { lastError: record.lastError } : {}),
  };
}

/** Convert pre-migration Blob fields once, without ever writing them back. */
export async function normalizeOutgoingDmTask(record: LegacyOutgoingDmTask) {
  const normalized: Record<string, unknown> = { ...record };
  let changed = false;
  if (!record.imageBytes && isReadableBlob(record.imageBlob)) {
    normalized.imageBytes = await record.imageBlob.arrayBuffer();
    changed = true;
  }
  if ("imageBlob" in normalized) {
    delete normalized.imageBlob;
    changed = true;
  }
  if (record.preparedImage) {
    const prepared: Record<string, unknown> = { ...record.preparedImage };
    if (!record.preparedImage.encryptedBytes && isReadableBlob(record.preparedImage.encryptedBlob)) {
      prepared.encryptedBytes = await record.preparedImage.encryptedBlob.arrayBuffer();
      changed = true;
    }
    if (!record.preparedImage.previewBytes && isReadableBlob(record.preparedImage.previewBlob)) {
      prepared.previewBytes = await record.preparedImage.previewBlob.arrayBuffer();
      changed = true;
    }
    if ("encryptedBlob" in prepared) { delete prepared.encryptedBlob; changed = true; }
    if ("previewBlob" in prepared) { delete prepared.previewBlob; changed = true; }
    normalized.preparedImage = prepared;
  }
  if (record.preparedAudio) {
    normalized.preparedAudio = {
      encryptedBytes: cloneBuffer(record.preparedAudio.encryptedBytes),
      encryptedName: record.preparedAudio.encryptedName,
      mime: record.preparedAudio.mime,
      iv: record.preparedAudio.iv,
      key: record.preparedAudio.key,
      duration: record.preparedAudio.duration,
      size: record.preparedAudio.size,
    };
  }
  return { task: plainOutgoingTask(normalized as OutgoingDmTaskRecord), changed };
}

export class OutgoingDmTaskRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  async get(accountPubkey: string, localId: string) {
    const key: [string, string] = [normalizeAccountPubkey(accountPubkey), localId];
    const stored = await this.database.outgoingDmTasks.get(key) as LegacyOutgoingDmTask | undefined;
    if (!stored) return undefined;
    const normalized = await normalizeOutgoingDmTask(stored);
    if (normalized.changed) await this.database.outgoingDmTasks.put(normalized.task);
    return normalized.task;
  }

  async put(record: OutgoingDmTaskRecord) {
    const normalized = await normalizeOutgoingDmTask({
      ...record,
      accountPubkey: normalizeAccountPubkey(record.accountPubkey),
    } as LegacyOutgoingDmTask);
    await this.database.outgoingDmTasks.put(normalized.task);
    return normalized.task;
  }

  async update(accountPubkey: string, localId: string, patch: Partial<OutgoingDmTaskRecord>) {
    const account = normalizeAccountPubkey(accountPubkey);
    const current = await this.database.outgoingDmTasks.get([account, localId]) as LegacyOutgoingDmTask | undefined;
    if (!current) return undefined;
    return this.put({ ...current, ...patch, accountPubkey: account, localId } as OutgoingDmTaskRecord);
  }

  async list(accountPubkey: string) {
    const rows = await this.database.outgoingDmTasks.where("accountPubkey").equals(normalizeAccountPubkey(accountPubkey)).toArray();
    return Promise.all(rows.map(row => this.put(row)));
  }
}

export const outgoingDmTaskRepository = new OutgoingDmTaskRepository();
