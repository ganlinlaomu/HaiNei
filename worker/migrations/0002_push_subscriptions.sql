CREATE TABLE IF NOT EXISTS hainei_push_subscriptions (
  account_pubkey TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_pubkey, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_hainei_push_subscriptions_account
  ON hainei_push_subscriptions(account_pubkey);
