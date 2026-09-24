CREATE TABLE IF NOT EXISTS hainei_account_snapshots (
  account_pubkey TEXT NOT NULL,
  namespace TEXT NOT NULL,
  version INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  device_id TEXT,
  PRIMARY KEY (account_pubkey, namespace)
);

CREATE INDEX IF NOT EXISTS idx_hainei_account_snapshots_updated
  ON hainei_account_snapshots(account_pubkey, updated_at);
