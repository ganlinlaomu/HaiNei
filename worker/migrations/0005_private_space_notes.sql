-- Encrypted per-note blobs, including durable encrypted tombstones for offline devices.
CREATE TABLE IF NOT EXISTS hainei_private_space_notes (
  account_pubkey TEXT NOT NULL,
  note_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_pubkey, note_id)
);
CREATE INDEX IF NOT EXISTS idx_hainei_private_space_by_account
  ON hainei_private_space_notes(account_pubkey, note_id);
