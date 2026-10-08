# HaiNei private runtime metrics (read-only bridge)

This endpoint returns aggregates from the existing Cloudflare D1 database, not simulated data. It neither adds client telemetry nor publishes sensitive user data.

## Setup (Cloudflare Worker admin only)

1. Confirm existing worker/migrations are applied to production D1.
2. Configure a **new high-entropy administrator-only secret** for the HaiNei Worker named METRICS_READ_TOKEN (32-256 URL-safe characters). Example in a trusted local shell:

    openssl rand -hex 32 | npm exec wrangler -- secret put METRICS_READ_TOKEN --config worker/wrangler.toml

3. Deploy the Worker through the normal CI-approved release process.
4. From a trusted administrator server environment, use the token in the HTTP Authorization header, never in a URL:

    curl --fail --header "Authorization: Bearer $METRICS_READ_TOKEN" https://hainei-media.noster.workers.dev/api/admin/metrics

5. Connecting these data to ChatGPT requires a separate authenticated MCP/server-side integration with the read-only endpoint. This PR does **not** install a connector or give Cloudflare access to ChatGPT.

Never copy credentials into chats, repositories, browser storage, Vite environment variables or unprotected dashboards. Do not reuse Nostr private keys, recovery PINs, Relay App or media service credentials.

## Metric definitions

| Field | Meaning |
| --- | --- |
| accountsWithEncryptedSnapshots | Distinct accounts with at least one encrypted account-state snapshot. Not total registrations. |
| accountsWithRecentSnapshotChanges24h | Distinct accounts with snapshot changes in the rolling previous 24h. Not DAU. |
| accountsWithRecentSnapshotChanges7d | Distinct accounts with snapshot changes in the rolling previous 7d. Not WAU. |
| pushSubscribedAccounts | Distinct accounts with saved push subscriptions; not online users. |
| pushRegisteredEndpoints | Stored push device endpoints, possibly multiple per account. |
| pushCopiesRecorded7d | Recent rows in the push-delivery table, subject to retention cleanup. |
| pushCopiesAcceptedByProvider7d | Rows marked sent by the upstream push provider; not delivery to the device. |
| syncedAccountsByDay | Distinct accounts with snapshot changes per UTC day, for the last 7 calendar dates. |

No account public keys, ciphertext, message IDs, IP addresses, push endpoints, device IDs, or decrypted content are returned. The endpoint rejects missing/invalid Bearer credentials, has no CORS allowance and uses no-store caching.

## Not currently measurable

Full DAU, Relay connection success rate, actual NIP-17 DM delivery/read success rate and frontend page load latency are **not** available in these D1 tables. Device-local Debug Console events cannot be counted server-side. Collecting these later needs a separate privacy/consent review, aggregate instrumentation and an explicit definition for each measure.

GitHub code can verify implementation, but cannot verify production D1 readings until the Worker is deployed and securely queried.
