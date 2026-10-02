import Dexie from "dexie";
import { gcm } from "@noble/ciphers/aes";

const keys = new Map<string, Uint8Array>();
const protectedAccounts = new Set<string>();
const encoder = new TextEncoder();
// Index metadata remains searchable. All content and embedded media keys are sealed.
const fields: Record<string, string[]> = {
  syncedMessages: ["plaintext", "tags"],
  decryptedEvents: ["message"],
  deferredAuthorizationMessages: ["message"],
  accountMessages: ["content"],
  accountMeta: ["value"],
  outgoingQueue: ["message", "events", "lastError"],
  outgoingDmTasks: [
    "text",
    "imageBytes",
    "preparedImage",
    "preparedAudio",
    "uploadedRef",
    "lastError",
  ],
  accountStateMirrors: ["data"],
  replaceableEventOutbox: ["event", "lastError"],
  accountProfiles: ["nickname", "bio", "avatar"],
};
export function lockLocalVault(account: string) {
  keys.get(account)?.fill(0);
  keys.delete(account);
}

export function isLocalVaultUnlocked(account: string) {
  return keys.has(account);
}

function binaryAssociated(
  purpose: string,
  account: string,
  identifier: string,
  mime: string,
  size: number,
) {
  return encoder.encode(
    JSON.stringify(["hainei-vault-binary", 1, purpose, account, identifier, mime, size]),
  );
}

export async function sealLocalVaultBytes(
  account: string,
  purpose: string,
  identifier: string,
  mime: string,
  plainBytes: ArrayBuffer,
) {
  const keyBytes = keys.get(account);
  if (!keyBytes) throw new Error("local_vault_locked");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: binaryAssociated(
        purpose,
        account,
        identifier,
        mime,
        plainBytes.byteLength,
      ),
    },
    cryptoKey,
    plainBytes,
  );
  return {
    iv: iv.slice().buffer,
    bytes,
  };
}

export async function openLocalVaultBytes(
  account: string,
  purpose: string,
  identifier: string,
  mime: string,
  size: number,
  iv: ArrayBuffer,
  sealedBytes: ArrayBuffer,
) {
  const keyBytes = keys.get(account);
  if (!keyBytes) throw new Error("local_vault_locked");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(iv),
      additionalData: binaryAssociated(
        purpose,
        account,
        identifier,
        mime,
        size,
      ),
    },
    cryptoKey,
    sealedBytes,
  );
  if (keys.get(account) !== keyBytes) {
    new Uint8Array(plain).fill(0);
    throw new Error("local_vault_locked");
  }
  return plain;
}
export async function unlockLocalVault(
  account: string,
  privateKeyHex: string,
  isCurrent: () => boolean = () => true,
) {
  if (!/^[0-9a-f]{64}$/i.test(privateKeyHex))
    throw new Error("vault_requires_private_key");
  const secret = Uint8Array.from(privateKeyHex.match(/../g)!, (v) =>
    parseInt(v, 16),
  );
  try {
    const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode(account),
        info: encoder.encode("HaiNei local vault v1"),
      },
      base,
      256,
    );
    if (!isCurrent()) {
      new Uint8Array(bits).fill(0);
      return;
    }
    lockLocalVault(account);
    keys.set(account, new Uint8Array(bits));
    protectedAccounts.add(account);
  } finally {
    secret.fill(0);
  }
}
function encodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function serialize(value: unknown) {
  return JSON.stringify(value, (_k, v) =>
    v instanceof ArrayBuffer
      ? { $vaultBase64: encodeBytes(new Uint8Array(v)) }
      : v,
  );
}
function deserialize(value: string) {
  return JSON.parse(value, (_k, v) =>
    v && typeof v.$vaultBase64 === "string"
      ? Uint8Array.from(atob(v.$vaultBase64), (c) => c.charCodeAt(0)).buffer
      : v,
  );
}
function associated(table: string, row: any, primaryKey: unknown) {
  return encoder.encode(
    JSON.stringify(["hainei-vault", 1, table, row.accountPubkey, primaryKey]),
  );
}
export function installLocalVault(database: Dexie, requireUnlock = false) {
  database.use({
    stack: "dbcore",
    name: "hainei-local-vault",
    level: 1,
    create: (down) => ({
      ...down,
      table(name) {
        const table = down.table(name);
        if (!fields[name]) return table;
        const decrypt = (row: any) => {
          if (!row?._vault) return row;
          const key = keys.get(row.accountPubkey);
          if (!key) throw new Error("local_vault_locked");
          if (row._vault.v !== 1) throw new Error("unsupported_vault_version");
          const plaintext = gcm(
            key,
            row._vault.iv,
            associated(name, row, table.schema.primaryKey.extractKey?.(row)),
          ).decrypt(row._vault.bytes);
          try {
            const { _vault, ...metadata } = row;
            return {
              ...metadata,
              ...deserialize(new TextDecoder().decode(plaintext)),
            };
          } finally {
            plaintext.fill(0);
          }
        };
        const encrypt = (input: any, upgrading = false) => {
          const row = decrypt(input);
          if (
            !row?.accountPubkey ||
            (!protectedAccounts.has(row.accountPubkey) &&
              (!requireUnlock || upgrading))
          )
            return row;
          const key = keys.get(row.accountPubkey);
          if (!key) throw new Error("local_vault_locked");
          const metadata = { ...row };
          const content: Record<string, unknown> = {};
          for (const field of fields[name]) {
            if (field in metadata) {
              content[field] = metadata[field];
              delete metadata[field];
            }
          }
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const plaintext = encoder.encode(serialize(content));
          try {
            return {
              ...metadata,
              _vault: {
                v: 1,
                iv,
                bytes: gcm(
                  key,
                  iv,
                  associated(
                    name,
                    row,
                    table.schema.primaryKey.extractKey?.(row),
                  ),
                ).encrypt(plaintext),
              },
            };
          } finally {
            plaintext.fill(0);
          }
        };
        return {
          ...table,
          mutate(req) {
            return table.mutate(
              req.type === "add" || req.type === "put"
                ? {
                    ...req,
                    values: req.values.map((value) =>
                      encrypt(
                        value,
                        (req.trans as IDBTransaction).mode === "versionchange",
                      ),
                    ),
                  }
                : req,
            );
          },
          async get(req) {
            return decrypt(await table.get(req));
          },
          async getMany(req) {
            return (await table.getMany(req)).map(decrypt);
          },
          async query(req) {
            const result = await table.query(req);
            return req.values
              ? { ...result, result: result.result.map(decrypt) }
              : result;
          },
          async openCursor(req) {
            const cursor = await table.openCursor(req);
            if (!cursor || !req.values) return cursor;
            return new Proxy(cursor, {
              get(target, prop) {
                if (prop === "value") return decrypt(target.value);
                const value = Reflect.get(target, prop, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        };
      },
    }),
  });
}
// Each batch is atomic. Interrupted migrations resume by rewriting rows safely.
// No old row is deleted before its authenticated replacement is committed.
export async function migrateLocalVault(database: Dexie, account: string) {
  if (!keys.has(account)) throw new Error("local_vault_locked");
  const meta = database.table("accountMeta");
  if ((await meta.get([account, "local_vault_migrated_v1"]))?.value === true)
    return;
  for (const name of Object.keys(fields)) {
    const table = database.table(name);
    let after: any = undefined;
    while (true) {
      const rows = await (
        after === undefined
          ? table
              .where(":id")
              .between([account, Dexie.minKey], [account, Dexie.maxKey])
          : table
              .where(":id")
              .between(after, [account, Dexie.maxKey], false, true)
      )
        .limit(100)
        .toArray();
      if (!rows.length) break;
      after =
        table.schema.primKey.keyPath instanceof Array
          ? table.schema.primKey.keyPath.map((k) => rows.at(-1)[k])
          : rows.at(-1)[table.schema.primKey.keyPath as string];
      const own = rows.filter((row) => row.accountPubkey === account);
      if (own.length) await table.bulkPut(own);
    }
  }
  // Previous decrypted image caches are disposable and may use key-bearing URLs.
  // Remove legacy plaintext duplicates only after verifying the sealed copy.
  for (const [legacyName, scopedName, keyName, contentName] of [
    ["messages", "accountMessages", "id", "content"],
    ["meta", "accountMeta", "key", "value"],
  ]) {
    const legacy = database.table(legacyName);
    const scoped = database.table(scopedName);
    let after: any = undefined;
    while (true) {
      const rows = await (
        after === undefined
          ? legacy.toCollection()
          : legacy.where(":id").above(after)
      )
        .limit(100)
        .toArray();
      if (!rows.length) break;
      after = rows.at(-1)[keyName];
      await database.transaction("rw", legacy, scoped, async () => {
        for (const row of rows) {
          const copy = await scoped.get([account, row[keyName]]);
          if (
            !copy ||
            JSON.stringify(copy[contentName]) !==
              JSON.stringify(row[contentName])
          )
            continue;
          if (
            legacyName === "messages" &&
            (copy.pubkey !== row.pubkey?.toLowerCase() ||
              copy.created_at !== row.created_at)
          )
            continue;
          await legacy.delete(row[keyName]);
        }
      });
    }
  }
  await database.table("imageCache").clear();
  const images = database.table("accountImageCache");
  await images.where("accountPubkey").equals(account).delete();
  await meta.put({
    accountPubkey: account,
    key: "local_vault_migrated_v1",
    value: true,
  });
}
