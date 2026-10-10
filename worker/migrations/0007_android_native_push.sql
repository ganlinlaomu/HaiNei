-- Native Android FCM tokens are not Web Push endpoints and have their own storage.
-- The token hash is globally unique: an installation can belong to only one account.
CREATE TABLE IF NOT EXISTS hainei_native_push_tokens (
  token_hash TEXT PRIMARY KEY,
  account_pubkey TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hainei_native_push_account
  ON hainei_native_push_tokens(account_pubkey, updated_at);
