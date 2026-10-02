const DATABASE_NAME = "hainei_device_credentials";
const STORE_NAME = "privateKeys";
const VERSION = 1;
const IV_LENGTH = 12;

type DevicePrivateKeyRecord = {
  pubkey: string;
  wrappingKey: CryptoKey;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  version: 1;
  updatedAt: number;
};

function normalize(pubkey: string) {
  return pubkey.toLowerCase();
}

function copyBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return source.slice().buffer;
}

function associatedData(pubkey: string) {
  return new TextEncoder().encode(JSON.stringify(["hainei-device-private-key", VERSION, normalize(pubkey)]));
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("device_credential_request_failed"));
  });
}

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("此环境不支持在本机保持登录"));
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "pubkey" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("device_credential_database_failed"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("device_credential_transaction_aborted"));
      transaction.onerror = () => reject(transaction.error || new Error("device_credential_transaction_failed"));
    });
    const result = await requestResult(run(transaction.objectStore(STORE_NAME)));
    await completed;
    return result;
  } finally {
    database.close();
  }
}

async function readRecord(pubkey: string) {
  return withStore("readonly", store => store.get(normalize(pubkey))) as Promise<DevicePrivateKeyRecord | undefined>;
}

export async function storeDevicePrivateKey(pubkey: string, privateKeyHex: string) {
  if (!/^[0-9a-f]{64}$/i.test(pubkey) || !/^[0-9a-f]{64}$/i.test(privateKeyHex)) throw new Error("私钥格式不正确");
  if (typeof crypto === "undefined" || !crypto.subtle) throw new Error("此环境不支持安全的本机凭据存储");
  const normalized = normalize(pubkey);
  const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(privateKeyHex.toLowerCase());
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: associatedData(normalized) },
      wrappingKey,
      plaintext,
    );
    await withStore("readwrite", store => store.put({
      pubkey: normalized,
      wrappingKey,
      iv: copyBuffer(iv),
      ciphertext: copyBuffer(ciphertext),
      version: VERSION,
      updatedAt: Date.now(),
    } satisfies DevicePrivateKeyRecord));
    // Verify that this browser can structured-clone and use a non-exportable CryptoKey.
    try {
      if (await unlockDevicePrivateKey(normalized) !== privateKeyHex.toLowerCase()) throw new Error("device_credential_verification_failed");
    } catch (error) {
      await removeDevicePrivateKey(normalized).catch(() => undefined);
      throw error;
    }
  } finally {
    plaintext.fill(0);
  }
}

export async function unlockDevicePrivateKey(pubkey: string) {
  const record = await readRecord(pubkey);
  if (
    !record
    || record.version !== VERSION
    || record.wrappingKey?.type !== "secret"
    || record.wrappingKey.extractable
    || !record.wrappingKey.usages.includes("decrypt")
  ) throw new Error("未找到本机登录凭据");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(record.iv), additionalData: associatedData(pubkey) },
    record.wrappingKey,
    record.ciphertext,
  );
  const privateKey = new TextDecoder().decode(plaintext);
  new Uint8Array(plaintext).fill(0);
  if (!/^[0-9a-f]{64}$/i.test(privateKey)) throw new Error("本机登录凭据已损坏");
  return privateKey.toLowerCase();
}

export async function hasDevicePrivateKey(pubkey: string) {
  try { return !!(await readRecord(pubkey)); } catch { return false; }
}

export async function removeDevicePrivateKey(pubkey: string) {
  if (!pubkey || typeof indexedDB === "undefined") return;
  await withStore("readwrite", store => store.delete(normalize(pubkey)));
}
