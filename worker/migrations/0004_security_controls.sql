CREATE TABLE IF NOT EXISTS hainei_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hainei_rate_limits_expires
  ON hainei_rate_limits(expires_at);

CREATE TABLE IF NOT EXISTS hainei_push_authorizations (
  recipient_pubkey TEXT NOT NULL,
  sender_pubkey TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recipient_pubkey, sender_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_hainei_push_authorizations_sender
  ON hainei_push_authorizations(sender_pubkey, expires_at);

CREATE TABLE IF NOT EXISTS hainei_push_deliveries (
  sender_pubkey TEXT NOT NULL,
  recipient_pubkey TEXT NOT NULL,
  message_id TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sending', 'sent')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sender_pubkey, recipient_pubkey, message_id, endpoint_hash)
);

CREATE INDEX IF NOT EXISTS idx_hainei_push_deliveries_updated
  ON hainei_push_deliveries(updated_at);
