# HaiNei v2 PR1 stability test plan

Run these checks against a development build with `nostr_debug=1`. Use two test
accounts and disposable relay data; never paste private keys into logs or issue
reports.

## Baseline

```bash
npm ci
npm run build
```

In the browser console, enable debug logs and reload:

```js
localStorage.setItem("nostr_debug", "1");
location.reload();
```

## A. Account A to a new account B

1. Log in as A, add three friends, receive ten inbox posts and at least one
   interaction/notification, and configure a distinctive Relay and Blossom URL.
2. Log out through the application, then log in as a new account B.
3. Inspect the Friends, Home, Notifications and Settings views.
4. In DevTools, confirm the global mirrors are absent or contain only B's data:

```js
({
  relays: localStorage.getItem("custom-relays"),
  blossomServers: localStorage.getItem("blossom_servers"),
  blossomUrl: localStorage.getItem("blossom_upload_url"),
  hasBlossomToken: Boolean(localStorage.getItem("blossom_token")),
});
```

Expected: B has zero friends and none of A's inbox, interactions or
notifications. A's Relay, Blossom URL and token are not active for B.

## B. Restore B to A

1. Log out B and log back in as A.
2. Confirm A's friends, inbox, interactions and notifications are restored.
3. Confirm these keys still exist after logout (replace `<A_PK>`):

```js
[
  "nostr_inbox_<A_PK>",
  "nostr_outbox_<A_PK>",
  "nostr_friends_<A_PK>",
  "interactions_<A_PK>",
  "nostr_notifications_<A_PK>",
  "nostr_settings_<A_PK>",
].map(key => [key, localStorage.getItem(key) !== null]);
```

Expected: every previously-created account-scoped record remains available.

## C. Late callback during account switch

1. In DevTools Network, throttle the connection, log in as A, and trigger Home
   backfill.
2. Before EOSE/decryption completes, log out A and log in as B.
3. Remove throttling and wait for the old relay responses.

Expected: logs contain `[account] ... discarded account=<A prefix>` and no A
event appears in B's `nostr_inbox_<B_PK>`, `interactions_<B_PK>` or notification
records.

## D. WebSocket reconnect and REQ replay

1. Log in and leave Home open with a kind 8964 subscription.
2. In DevTools Network, select each relay WebSocket and close it, or briefly
   disable/re-enable the network.
3. Wait for reconnect and have a friend publish a new post without refreshing.

Expected: `[relay] replay subscription relay=... sub=...` is logged and the new
post arrives without a page refresh.

## E. Multiple Relay EOSE

Use two test relays or a relay proxy: Relay A sends EOSE after about 100 ms;
Relay B sends an additional event after about 1 second and then EOSE. Trigger a
friends/settings fetch and a message backfill.

Expected: the subscription stays open after A's EOSE, logs progress as
`eose=1/2`, accepts B's event, then completes at `eose=2/2` (or the configured
timeout). Friends/settings select the newest valid candidate across both relays.

## F. Same-second delayed events

1. Publish events A, B and C with the same `created_at = T`, but make only A
   available for the first backfill.
2. Confirm A is saved and the breakpoint is T.
3. Make B/C available and trigger the next backfill.

Expected: the second request starts at most at `T - 300`, and A/B/C are all
stored once by event ID. No request uses `since=T+1`.

## G. Pagination boundary

1. Configure a small batch limit in a test build and publish more than that
limit, with several oldest events sharing timestamp T.
2. Run backfill while inspecting relay REQ frames and `[backfill]` logs.

Expected: the next page still uses `until=T`; already-seen IDs are ignored; a
batch with unchanged `until` and zero new IDs stops instead of looping forever.

## Regression checks

Verify existing kind 8964 posts and kind 8965 interactions can still be read and
sent, including existing encrypted image/video references. No storage migration
or deletion should occur.
