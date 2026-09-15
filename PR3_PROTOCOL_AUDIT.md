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

Messages use a standard NIP-17 kind 14 rumor, NIP-44 v2 kind 13 seal, and
kind 1059 gift wrap. A separate wrap is produced for every recipient and for
the sender. Only the target `p` tag is exposed on each outer wrap. The same
rumor id is retained across all copies and is the canonical message id.

The application no longer subscribes to, sends, decodes, or imports the old
custom message and interaction kinds. Likes and comments are encrypted NIP-17
messages identified by an encrypted rumor label. A signer without NIP-44
support receives an explicit send error instead of using an older protocol.

## NIP-17 validation

The receive adapter checks the outer signature and kind, exactly one matching
recipient tag, the seal signature/kind/empty tags, rumor event shape and id,
seal/rumor sender equality, rumor kind, and current-account membership. All
parse/decrypt failures return `null` and do not stop the subscription.

Gift-wrap subscription timestamps include the two-day NIP-17 timestamp skew,
so a wrapper randomized into the past is not excluded by a rumor-time cursor.

## Compatibility and scope

- Existing account-scoped storage keys and the PR2 Dexie schema are unchanged.
- Old custom-protocol inbox entries are ignored; there is no read migration or
  fallback decoder.
- Relay discovery/ranking, NIP-65/NIP-10050 routing, final group protocol,
  attachments, push notifications, service workers, nostrdb, and UI design are
  intentionally not changed in PR3.
