# PR3 message protocol audit

## Before

- `src/stores/posts.ts` created the custom message wire payload and signed kind 8964 directly.
- Despite its name, `publishNip44PerMessage` used AES-GCM for content and NIP-04 to wrap a symmetric key; it was not NIP-44.
- `Home.vue` subscribed only to kind 8964 and repeated its JSON/NIP-04/AES decryption logic in realtime and backfill paths.
- `interactions.ts` created, subscribed to, and decoded kind 8965 directly.
- Logical message identity was always assumed to be the relay event id.
- Decrypted payloads had no protocol-neutral representation.

## After

`src/nostr/messaging` now separates:

1. protocol encoding/decoding (`CanonicalMessage` and adapters);
2. subscription planning;
3. logical-message deduplication;
4. relay publication.

New posts prefer a standard NIP-17 kind 14 rumor, NIP-44 v2 kind 13 seal, and
kind 1059 gift wrap. A separate wrap is produced for every recipient and for
the sender. Only the target `p` tag is exposed on each outer wrap. The same
rumor id is retained across all copies and is the canonical message id.

Legacy kinds remain readable through adapters. If the active signer cannot
perform NIP-44, the send policy can use the legacy 8964 adapter rather than
silently producing a non-standard NIP-17 event. Legacy 8965 interactions also
use their adapter instead of constructing or decoding the wire payload in the
store.

## NIP-17 validation

The receive adapter checks the outer signature and kind, exactly one matching
recipient tag, the seal signature/kind/empty tags, rumor event shape and id,
seal/rumor sender equality, rumor kind, and current-account membership. All
parse/decrypt failures return `null` and do not stop the subscription.

Gift-wrap subscription timestamps include the two-day NIP-17 timestamp skew,
so a wrapper randomized into the past is not excluded by a rumor-time cursor.

## Compatibility and scope

- Existing account-scoped storage keys and the PR2 Dexie schema are unchanged.
- Old inbox entries without protocol metadata are inferred as legacy 8964 on read.
- Relay discovery/ranking, NIP-65/NIP-10050 routing, final group protocol,
  attachments, push notifications, service workers, nostrdb, and UI design are
  intentionally not changed in PR3.
