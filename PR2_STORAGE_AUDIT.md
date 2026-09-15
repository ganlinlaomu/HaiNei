# PR2 local storage audit

## Root cause

IndexedDB `closed_community_db` v1/v2 used global primary keys (`id`, `pubkey`,
`key`, and `url`) and had no owner field. The legacy Nostr store loaded
`db.messages.orderBy("created_at").reverse().toArray()`, so any account opening
that store received every cached message. The image cache stored decrypted Blob
data globally by encrypted URL. The post outbox error path also wrote to the
fixed localStorage key `nostr-outbox`.

## Database before

| Version | Table | Schema | Use |
| --- | --- | --- | --- |
| 1 | `messages` | `id, created_at, pubkey` | Legacy cached Nostr messages |
| 1 | `friends` | `pubkey, name, group` | Legacy local friends |
| 1 | `meta` | `key` | Legacy metadata |
| 2 | `imageCache` | `url, timestamp` | Decrypted image Blob cache |

There are no Dexie tables for conversations, groups, interactions, unread
state, drafts, relay events, or subscription cursors. Those features are either
absent or use account-prefixed localStorage records.

## Database after

Version 3 retains the old tables as quarantined legacy storage and adds:

| Table | Primary key and indexes |
| --- | --- |
| `accountMessages` | `[accountPubkey+id]`, `accountPubkey`, `[accountPubkey+created_at]`, `[accountPubkey+pubkey]`, `[accountPubkey+pubkey+created_at]` |
| `accountFriends` | `[accountPubkey+pubkey]`, `accountPubkey`, `[accountPubkey+name]`, `[accountPubkey+group]` |
| `accountMeta` | `[accountPubkey+key]`, `accountPubkey` |
| `accountImageCache` | `[accountPubkey+url]`, `accountPubkey`, `[accountPubkey+timestamp]` |

Application code accesses the new tables only through repositories whose APIs
require `accountPubkey`. Queries use account or compound indexes rather than a
full-table `toArray().filter(...)`.

## Migration policy

During v2 to v3 upgrade, legacy private rows are copied only when browser
storage identifies exactly one 64-character account pubkey. Evidence includes
the current login, registered accounts, and existing account-prefixed keys. If
zero or multiple owners are found, legacy rows remain in the old tables and are
never returned by the new repositories. No database or historical row is
deleted.

## Other browser storage

Already account-scoped and retained for compatibility:

- `nostr_inbox_${pk}` / `nostr_outbox_${pk}`
- `nostr_friends_${pk}`
- `interactions_${pk}`
- `nostr_notifications_${pk}` and associated dismissed/meta keys
- `nostr_settings_${pk}`
- `home_lastSeenCreatedAt_${pk}`
- `backfill_breakpoint_messages_${pk}` and `backfill_breakpoint_interactions_${pk}`
- `encrypted_sk_${pk}`

Global values that remain are current-session identity, application version,
debug preferences, and compatibility mirrors for active Relay/Blossom settings.
PR1 owns the lifecycle clearing of those active-account mirrors.

Public Nostr profile/event cache is not currently implemented in Dexie, so PR2
does not introduce or duplicate a global public cache.
