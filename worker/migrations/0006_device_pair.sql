-- Short-lived encrypted device pairing handoff. No plaintext key is stored.
CREATE TABLE IF NOT EXISTS hainei_device_pairs (
  id TEXT PRIMARY KEY,
  receiver_key TEXT NOT NULL,
  poll_token_hash TEXT NOT NULL,
  sender_key TEXT,
  sender_pubkey TEXT,
  ciphertext TEXT,
  iv TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending', 'offered', 'delivered', 'consumed', 'cancelled')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hainei_device_pairs_expiry ON hainei_device_pairs(expires_at);
