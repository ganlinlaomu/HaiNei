-- A subscription-scoped capability lets lifecycle heartbeats avoid account
-- signatures. Only its SHA-256 hash is stored by the Worker.
ALTER TABLE hainei_push_subscriptions ADD COLUMN presence_token_hash TEXT;

-- Foreground message pushes are delayed, never discarded. The queue is only
-- a durable wake-up mechanism; D1 remains the source of truth across retries.
CREATE TABLE IF NOT EXISTS hainei_pending_pushes (
  sender_pubkey TEXT NOT NULL,
  recipient_pubkey TEXT NOT NULL,
  message_id TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  hint_json TEXT,
  deliver_after INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sender_pubkey, recipient_pubkey, message_id, endpoint_hash)
);

CREATE INDEX IF NOT EXISTS idx_hainei_pending_pushes_endpoint
  ON hainei_pending_pushes(endpoint_hash, deliver_after);

CREATE INDEX IF NOT EXISTS idx_hainei_pending_pushes_expiry
  ON hainei_pending_pushes(expires_at);
