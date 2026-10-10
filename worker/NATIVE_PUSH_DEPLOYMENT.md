# HaiNei Android APK FCM native push

This addition does not modify iOS/Safari or Chromium Web Push. Only NIP-17 private-message notifications are eligible. Notification body contains no user, sender or message content.

## Required Firebase setup

1. Create a Firebase Android app with exact application ID `cafe.aso.hainei`.
2. Download the Android app's `google-services.json`.
3. Set GitHub Actions secret `HAINEI_FIREBASE_CONFIG_BASE64` to the **base64 of the entire google-services.json file** (not the file path). No secrets are committed. The Android workflow adds the Capacitor 8 push plugin and config only when the secret exists. Without it, legacy APK builds continue but native push remains unavailable.
4. Enable the **Firebase Cloud Messaging API (HTTP v1)** in Google Cloud for that Firebase project. Create a service account with the minimum FCM send permission and store its service-account JSON in the Cloudflare Worker secret `FCM_SERVICE_ACCOUNT_JSON`:

   `npx wrangler secret put FCM_SERVICE_ACCOUNT_JSON --config worker/wrangler.toml`

   Paste the complete JSON. Never add the service account JSON to Android or GitHub source.

5. Apply migration **before** deploying the Worker, then deploy Worker and build/release a **new Android APK**:

   `npx wrangler d1 migrations apply DB --remote --config worker/wrangler.toml`

   `npx wrangler deploy --config worker/wrangler.toml`

6. On the newly installed APK, open System Settings > Android Push, grant notification permission, and tap Enable Push. The signed request registers the token for the active Nostr account and refreshes its accepted-friend authorization policy. Use Test local push to validate delivery.

## Behavior and operational considerations

- D1 table `hainei_native_push_tokens` has a globally unique token hash so one installation cannot target two accounts simultaneously. Switching accounts or signing out unregisters the old FCM token; login with enabled settings registers afresh.
- Push policy, sender auth and per-message/device idempotency are shared with existing Web Push. Web Push VAPID credentials remain unchanged.
- Native notifications use Android channel `hainei_messages`; Android 13+ needs user notification permission.
- FCM is usually dependent on Google Play services, which cannot be assumed on all devices or networks. Emulator with Google Play services can perform an integration smoke test; automated tests and APK compilation are not proof of device display.
- If FCM credentials have not been provided, the native UI must remain unavailable rather than claiming notifications work.
- Logs must not include FCM token values, service account JSON, message contents or full endpoints.
