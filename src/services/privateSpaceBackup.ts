import type { PrivateSpaceRecord } from "@/db/dexie";

export const PRIVATE_BACKUP_FORMAT = "hainei-private-space-backup";
export const PRIVATE_BACKUP_VERSION = 1;
export const BACKUP_KDF_ITERATIONS = 600_000;
export const MAX_BACKUP_FILE_BYTES = 18 * 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 12 * 1024 * 1024;
const MAX_ROWS = 5_000;
const ACCOUNT_RE = /^[0-9a-f]{64}$/;
const NOTE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type PrivateBackupNote = Pick<PrivateSpaceRecord,
  "id" | "kind" | "title" | "body" | "tasks" | "pinned" |
  "createdAt" | "updatedAt" | "revision" | "archivedAt" | "deletedAt">;
export type PrivateBackupPayload = {
  schemaVersion: 1;
  accountPubkey: string;
  items: PrivateBackupNote[];
};
export type PrivateBackupEnvelope = {
  format: typeof PRIVATE_BACKUP_FORMAT;
  version: 1;
  accountPubkey: string;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  cipher: "AES-256-GCM";
  salt: string;
  iv: string;
  ciphertext: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x4000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  }
  return btoa(result);
}
function base64ToBytes(value: unknown, size?: number): Uint8Array {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error("invalid_backup_encoding");
  const binary = atob(value);
  if (size !== undefined && binary.length !== size) throw new Error("invalid_backup_encoding");
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function validateAccount(account: string) {
  if (!ACCOUNT_RE.test(account)) throw new Error("invalid_backup_account");
}
function validatePassword(password: string) {
  const length = textEncoder.encode(password).byteLength;
  if (length < 12 || length > 256) throw new Error("backup_password_length");
}
function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validateNote(item: any): PrivateBackupNote {
  if (!item || typeof item !== "object" || !NOTE_ID_RE.test(item.id) ||
    (item.kind !== "note" && item.kind !== "todo") ||
    typeof item.title !== "string" || item.title.length > 500 ||
    typeof item.body !== "string" || item.body.length > 100_000 ||
    typeof item.pinned !== "boolean" || !Array.isArray(item.tasks) || item.tasks.length > 1_000 ||
    !finiteTimestamp(item.createdAt) || !finiteTimestamp(item.updatedAt) ||
    !Number.isSafeInteger(item.revision) || item.revision < 1 ||
    (item.archivedAt !== undefined && !finiteTimestamp(item.archivedAt)) ||
    (item.deletedAt !== undefined && !finiteTimestamp(item.deletedAt)))
    throw new Error("invalid_backup_note");
  const taskIds = new Set<string>();
  const tasks = item.tasks.map((task: any) => {
    if (!task || typeof task.id !== "string" || !task.id ||
      taskIds.has(task.id) || typeof task.text !== "string" ||
      task.text.length > 2_000 || typeof task.done !== "boolean")
      throw new Error("invalid_backup_task");
    taskIds.add(task.id);
    return { id: task.id, text: task.text, done: task.done };
  });
  return {
    id: item.id, kind: item.kind, title: item.title, body: item.body,
    tasks, pinned: item.pinned,
    createdAt: item.createdAt, updatedAt: item.updatedAt, revision: item.revision,
    ...(item.archivedAt === undefined ? {} : { archivedAt: item.archivedAt }),
    ...(item.deletedAt === undefined ? {} : { deletedAt: item.deletedAt }),
  };
}

/** Copy only the allowlisted fields. Never back up local cryptographic keys or cloud CAS fields. */
export function createBackupPayload(account: string, records: PrivateSpaceRecord[]): PrivateBackupPayload {
  validateAccount(account);
  if (records.length > MAX_ROWS) throw new Error("backup_too_many_notes");
  if (records.some(record => record.accountPubkey !== account)) throw new Error("backup_account_mismatch");
  const ids = new Set<string>();
  const items = records.map(record => {
    const item = validateNote(record);
    if (ids.has(item.id)) throw new Error("duplicate_backup_id");
    ids.add(item.id);
    return item;
  });
  const payload: PrivateBackupPayload = { schemaVersion: 1, accountPubkey: account, items };
  if (textEncoder.encode(JSON.stringify(payload)).length > MAX_PLAINTEXT_BYTES) throw new Error("backup_too_large");
  return payload;
}

export function parseBackupPayload(content: string, account: string): PrivateBackupPayload {
  validateAccount(account);
  if (textEncoder.encode(content).length > MAX_PLAINTEXT_BYTES) throw new Error("backup_too_large");
  let data: any;
  try { data = JSON.parse(content); } catch { throw new Error("invalid_backup_json"); }
  if (data?.schemaVersion !== 1 || data?.accountPubkey !== account || !Array.isArray(data?.items))
    throw new Error("backup_account_or_version_mismatch");
  if (data.items.length > MAX_ROWS) throw new Error("backup_too_many_notes");
  const ids = new Set<string>();
  const items = data.items.map((item: unknown) => {
    const note = validateNote(item);
    if (ids.has(note.id)) throw new Error("duplicate_backup_id");
    ids.add(note.id);
    return note;
  });
  return { schemaVersion: 1, accountPubkey: account, items };
}
async function deriveKey(password: string, salt: Uint8Array, usage: KeyUsage) {
  const material = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", iterations: BACKUP_KDF_ITERATIONS, salt },
    material, { name: "AES-GCM", length: 256 }, false, [usage],
  );
}
function associatedData(account: string) {
  return textEncoder.encode(JSON.stringify([PRIVATE_BACKUP_FORMAT, PRIVATE_BACKUP_VERSION, account]));
}

export async function encryptPrivateBackup(
  account: string, records: PrivateSpaceRecord[], password: string,
): Promise<string> {
  validatePassword(password);
  const payload = createBackupPayload(account, records);
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, "encrypt");
  const encrypted = await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: associatedData(account), tagLength: 128,
  }, key, plaintext);
  const envelope: PrivateBackupEnvelope = {
    format: PRIVATE_BACKUP_FORMAT, version: 1, accountPubkey: account,
    kdf: "PBKDF2-SHA256", iterations: BACKUP_KDF_ITERATIONS,
    cipher: "AES-256-GCM", salt: bytesToBase64(salt),
    iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
  const json = JSON.stringify(envelope);
  if (textEncoder.encode(json).length > MAX_BACKUP_FILE_BYTES) throw new Error("backup_too_large");
  return json;
}

export async function decryptPrivateBackup(
  fileContent: string, account: string, password: string,
): Promise<PrivateBackupPayload> {
  validateAccount(account);
  validatePassword(password);
  if (textEncoder.encode(fileContent).length > MAX_BACKUP_FILE_BYTES) throw new Error("backup_file_too_large");
  let envelope: any;
  try { envelope = JSON.parse(fileContent); } catch { throw new Error("invalid_backup_json"); }
  if (envelope?.format !== PRIVATE_BACKUP_FORMAT || envelope.version !== PRIVATE_BACKUP_VERSION ||
    envelope.accountPubkey !== account || envelope.kdf !== "PBKDF2-SHA256" ||
    envelope.iterations !== BACKUP_KDF_ITERATIONS || envelope.cipher !== "AES-256-GCM")
    throw new Error("backup_account_or_version_mismatch");
  const salt = base64ToBytes(envelope.salt, 16);
  const iv = base64ToBytes(envelope.iv, 12);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  if (ciphertext.length < 16 || ciphertext.length > MAX_PLAINTEXT_BYTES + 16)
    throw new Error("backup_file_too_large");
  const key = await deriveKey(password, salt, "decrypt");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM", iv, additionalData: associatedData(account), tagLength: 128,
    }, key, ciphertext);
  } catch { throw new Error("backup_password_or_integrity_failure"); }
  return parseBackupPayload(textDecoder.decode(plaintext), account);
}

export function exportPlainJson(account: string, records: PrivateSpaceRecord[]): string {
  return JSON.stringify(createBackupPayload(account, records), null, 2);
}
function escapeMarkdown(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/[\r\n]/g, " ").replace(/#/g, "\\#");
}
export function exportPlainMarkdown(account: string, records: PrivateSpaceRecord[]): string {
  const payload = createBackupPayload(account, records);
  return payload.items.map(item => [
    "## " + escapeMarkdown(item.title || "无标题"),
    "",
    item.kind === "todo"
      ? item.tasks.map(task => "- [" + (task.done ? "x" : " ") + "] " + task.text).join("\n")
      : item.body,
    "",
    "_状态：" + (item.deletedAt ? "最近删除" : item.archivedAt ? "已归档" : "正常") + "_",
  ].join("\n")).join("\n\n---\n\n");
}
