-- Shared to-do lists. Content is encrypted with a random per-list key; each
-- member row holds that key wrapped to the member with NIP-44 by the owner.
-- The Worker only checks membership and never sees titles or tasks.
CREATE TABLE IF NOT EXISTS hainei_shared_todos (
  list_id TEXT PRIMARY KEY,
  owner_pubkey TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hainei_shared_todo_members (
  list_id TEXT NOT NULL,
  member_pubkey TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, member_pubkey)
);
CREATE INDEX IF NOT EXISTS idx_hainei_shared_todo_members_by_member
  ON hainei_shared_todo_members(member_pubkey, list_id);
