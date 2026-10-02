const DATABASE_NAME = "hainei_remote_signer_credentials";
const STORE_NAME = "credentials";
const VERSION = 1;
const IV_LENGTH = 12;

export type RemoteSignerCredential = {
  accountPubkey: string;
  bunkerPubkey: string;
  relays: string[];
  bunkerSecret: string | null;
  clientSecretHex: string;
};

type RemoteSignerCredentialRecord = {
  accountPubkey: string;
  wrappingKey: CryptoKey;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  version: 1;
  updatedAt: number;
};

function normalizeHex(value: string, label: string) {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`invalid_${label}`);
  return normalized;
}

function normalizeRelays(relays: string[]) {
  const normalized = [...new Set(relays.map(value => value.trim()).filter(Boolean))];
  if (!normalized.length || normalized.length > 5) throw new Error("invalid_remote_signer_relays");
  return normalized.map(value => {
    const url = new URL(value);
    if (url.protocol !== "wss:") throw new Error("invalid_remote_signer_relay");
    return url.toString();
  });
}

function copyBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return source.slice().buffer;
}

function associatedData(accountPubkey: string) {
  return new TextEncoder().encode(
    JSON.stringify(["hainei-nip46-credential", VERSION, accountPubkey.toLowerCase()]),
  );
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("remote_signer_credential_request_failed"));
  });
}

function openDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("remote_signer_credential_storage_unavailable"));
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "accountPubkey" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("remote_signer_credential_database_failed"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("remote_signer_credential_transaction_aborted"));
      transaction.onerror = () => reject(transaction.error || new Error("remote_signer_credential_transaction_failed"));
    });
    const result = await requestResult(run(transaction.objectStore(STORE_NAME)));
    await completed;
    return result;
  } finally {
    database.close();
  }
}

async function readRecord(accountPubkey: string) {
  return withStore("readonly", store => store.get(accountPubkey.toLowerCase()))
    as Promise<RemoteSignerCredentialRecord | undefined>;
}

function serializeCredential(input: RemoteSignerCredential) {
  return JSON.stringify({
    bunkerPubkey: normalizeHex(input.bunkerPubkey, "bunker_pubkey"),
    relays: normalizeRelays(input.relays),
    bunkerSecret: typeof input.bunkerSecret === "string" ? input.bunkerSecret : null,
    clientSecretHex: normalizeHex(input.clientSecretHex, "client_secret"),
  });
}

function deserializeCredential(accountPubkey: string, plaintext: string): RemoteSignerCredential {
  const parsed = JSON.parse(plaintext) as Partial<RemoteSignerCredential>;
  return {
    accountPubkey: normalizeHex(accountPubkey, "account_pubkey"),
    bunkerPubkey: normalizeHex(String(parsed.bunkerPubkey || ""), "bunker_pubkey"),
    relays: normalizeRelays(Array.isArray(parsed.relays) ? parsed.relays.map(String) : []),
    bunkerSecret: typeof parsed.bunkerSecret === "string" ? parsed.bunkerSecret : null,
    clientSecretHex: normalizeHex(String(parsed.clientSecretHex || ""), "client_secret"),
  };
}

export async function storeRemoteSignerCredential(input: RemoteSignerCredential) {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("remote_signer_credential_crypto_unavailable");
  }
  const accountPubkey = normalizeHex(input.accountPubkey, "account_pubkey");
  const wrappingKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(serializeCredential({ ...input, accountPubkey }));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: associatedData(accountPubkey) },
      wrappingKey,
      plaintext,
    );
    await withStore("readwrite", store => store.put({
      accountPubkey,
      wrappingKey,
      iv: copyBuffer(iv),
      ciphertext: copyBuffer(ciphertext),
      version: VERSION,
      updatedAt: Date.now(),
    } satisfies RemoteSignerCredentialRecord));
    const verified = await unlockRemoteSignerCredential(accountPubkey);
    if (
      verified.bunkerPubkey !== normalizeHex(input.bunkerPubkey, "bunker_pubkey")
      || verified.clientSecretHex !== normalizeHex(input.clientSecretHex, "client_secret")
    ) {
      throw new Error("remote_signer_credential_verification_failed");
    }
  } catch (error) {
    await removeRemoteSignerCredential(accountPubkey).catch(() => undefined);
    throw error;
  } finally {
    plaintext.fill(0);
  }
}

export async function unlockRemoteSignerCredential(accountPubkey: string) {
  const account = normalizeHex(accountPubkey, "account_pubkey");
  const record = await readRecord(account);
  if (
    !record
    || record.version !== VERSION
    || record.wrappingKey?.type !== "secret"
    || record.wrappingKey.extractable
    || !record.wrappingKey.usages.includes("decrypt")
  ) {
    throw new Error("remote_signer_credential_not_found");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(record.iv), additionalData: associatedData(account) },
    record.wrappingKey,
    record.ciphertext,
  );
  try {
    return deserializeCredential(account, new TextDecoder().decode(plaintext));
  } finally {
    new Uint8Array(plaintext).fill(0);
  }
}

export async function hasRemoteSignerCredential(accountPubkey: string) {
  try {
    return !!(await readRecord(normalizeHex(accountPubkey, "account_pubkey")));
  } catch {
    return false;
  }
}

export async function removeRemoteSignerCredential(accountPubkey: string) {
  if (!accountPubkey || typeof indexedDB === "undefined") return;
  const account = accountPubkey.toLowerCase();
  await withStore("readwrite", store => store.delete(account));
}
