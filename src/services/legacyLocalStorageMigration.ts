import { db } from "@/db/dexie";
import { hydrateDeviceStorage } from "@/services/deviceStorage";
import { legacyBrowserStorageForMigration } from "@/services/legacyStorageAccess";

const MIGRATION_MARKER = "migration:localStorage:v1";
const GLOBAL_KEYS = new Set([
  "pkHex", "skHex", "loginMethod", "loginTimestamp", "isEncrypted",
  "bunkerInput", "bunkerClientSecretKey", "nostr_registered_accounts",
  "custom-relays", "hainei_active_relay_configs", "blossom_servers",
  "blossom_upload_url", "blossom_token", "blossom_timeout_ms",
  "blossom_auth_header", "hainei_device_id", "nostr_debug",
]);
const SCOPED_KEY = /^(?:encrypted_sk_|nostr_inbox_|nostr_outbox_|nostr_friends_|nostr_settings_|nostr_data_saver_|nostr_post_draft_|interactions_|nostr_notifications_|nostr_notifications_dismissed_|nostr_notifications_meta_|home_lastSeenCreatedAt_|backfill_breakpoint_(?:messages_|interactions_)?|hainei_push_enabled_|post_draft_)[0-9a-f]{64}(?:_.*)?$/i;
const DEVICE_KEY = /^(?:hainei_|app_|version_|last_update_|post_draft_)/i;

async function materializeLegacyFriendMetadata(key: string, value: string) {
  const match = key.match(/^nostr_friends_([0-9a-f]{64})$/i);
  if (!match) return true;
  const quarantine = async () => {
    const quarantineKey = `legacy_quarantine:${key}`;
    await db.deviceKeyValues.put({ key: quarantineKey, value, updatedAt: Date.now() });
    return (await db.deviceKeyValues.get(quarantineKey))?.value === value;
  };
  try {
    const parsed = JSON.parse(value);
    const list = Array.isArray(parsed) ? parsed : parsed?.list;
    if (!Array.isArray(list)) return quarantine();
    const accountPubkey = match[1].toLowerCase();
    const records = list
      .filter(item => item && typeof item.pubkey === "string" && /^[0-9a-f]{64}$/i.test(item.pubkey))
      .map(item => ({
        accountPubkey,
        pubkey: item.pubkey.toLowerCase(),
        name: typeof item.name === "string" ? item.name : undefined,
        note: typeof item.note === "string" ? item.note : undefined,
        group: typeof item.group === "string" ? item.group : undefined,
        groups: Array.isArray(item.groups) ? item.groups.filter((group: unknown) => typeof group === "string") : undefined,
        updatedAt: Number(item.updatedAt || parsed?.lastSyncTimestamp || Date.now()),
      }));
    if (records.length) await db.accountFriends.bulkPut(records);
    return (await db.accountFriends.where("accountPubkey").equals(accountPubkey).toArray()).length >= records.length;
  } catch {
    return quarantine();
  }
}

export async function migrateLegacyLocalStorage() {
  const storage = legacyBrowserStorageForMigration();
  if (!storage) return hydrateDeviceStorage();
  if (!await db.deviceKeyValues.get(MIGRATION_MARKER)) {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key);
    for (const key of keys) {
      if (!GLOBAL_KEYS.has(key) && !SCOPED_KEY.test(key) && !DEVICE_KEY.test(key)) continue;
      const value = storage.getItem(key);
      if (value === null) continue;
      await db.deviceKeyValues.put({ key, value, updatedAt: Date.now() });
      const mirrored = (await db.deviceKeyValues.get(key))?.value === value;
      const domainMaterialized = mirrored && await materializeLegacyFriendMetadata(key, value);
      if (mirrored && domainMaterialized) storage.removeItem(key);
    }
    await db.deviceKeyValues.put({ key: MIGRATION_MARKER, value: "complete", updatedAt: Date.now() });
  }
  await hydrateDeviceStorage();
}
