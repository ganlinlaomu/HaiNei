import { db, type HaiNeiDatabase, type PrivateSpaceRecord, type PrivateSpaceTask } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";
import { isLocalVaultUnlocked } from "@/services/localVault";
import { validatePrivateSpaceAttachments, validatePrivateSpaceSource } from "@/services/privateSpaceContent";

export type PrivateSpaceDraft = Pick<PrivateSpaceRecord, "kind" | "title" | "body" | "tasks" | "pinned"> &
  Partial<Pick<PrivateSpaceRecord, "source" | "attachments">>;

function requireUnlocked(account: string) {
  const normalized = normalizeAccountPubkey(account);
  if (!isLocalVaultUnlocked(normalized)) throw new Error("local_vault_locked");
  return normalized;
}

function validateDraft(draft: PrivateSpaceDraft): PrivateSpaceDraft {
  if (draft.kind !== "note" && draft.kind !== "todo") throw new Error("invalid_private_space_kind");
  if (draft.title.length > 500 || draft.body.length > 100_000 || draft.tasks.length > 1_000) {
    throw new Error("private_space_size_limit");
  }
  const ids = new Set<string>();
  const tasks: PrivateSpaceTask[] = draft.tasks.map(task => {
    if (!task.id || ids.has(task.id) || task.text.length > 2_000) throw new Error("invalid_private_space_task");
    ids.add(task.id);
    return { id: task.id, text: task.text, done: !!task.done };
  });
  return {
    kind: draft.kind, title: draft.title, body: draft.body, tasks, pinned: !!draft.pinned,
    ...(draft.source ? { source: validatePrivateSpaceSource(draft.source) } : {}),
    ...(draft.attachments !== undefined ? {
      attachments: validatePrivateSpaceAttachments(draft.attachments),
    } : {}),
  };
}

/**
 * A restored backup has no cloud CAS marker and may have a newer local timestamp
 * than the identical remote record. Compare semantic content (including deletion)
 * before making an artificial conflict copy. Never compare only title/body.
 */
export function samePrivateSpaceContents(
  left: PrivateSpaceRecord, right: PrivateSpaceRecord,
): boolean {
  return left.kind === right.kind
    && left.title === right.title
    && left.body === right.body
    && left.pinned === right.pinned
    && Number(left.archivedAt || 0) === Number(right.archivedAt || 0)
    && Number(left.deletedAt || 0) === Number(right.deletedAt || 0)
    && JSON.stringify(left.tasks) === JSON.stringify(right.tasks)
    && JSON.stringify(left.source ?? null) === JSON.stringify(right.source ?? null)
    && JSON.stringify(left.attachments ?? []) === JSON.stringify(right.attachments ?? []);
}

/** Local-first, account-scoped storage. PR1 never publishes a Nostr event or sends data to a Worker. */
export class PrivateSpaceRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  async list(account: string) {
    const owner = requireUnlocked(account);
    const rows = await this.database.accountNotes.where("accountPubkey").equals(owner).toArray();
    return rows.sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
  }

  async get(account: string, id: string) {
    return this.database.accountNotes.get([requireUnlocked(account), id]);
  }

  /** Confirm an upload without losing edits made while the HTTP request was in flight. */
  async markSynced(account: string, id: string, sentRevision: number, version: number) {
    const owner = requireUnlocked(account);
    await this.database.transaction("rw", this.database.accountNotes, async () => {
      const current = await this.database.accountNotes.get([owner, id]);
      if (!current || Number(current.syncedRevision || 0) > sentRevision) return;
      await this.database.accountNotes.put({
        ...current, cloudVersion: version, syncedRevision: sentRevision,
      });
    });
  }

  /** Import a remote version atomically; retain locally edited content as a new conflict copy. */
  async applyRemote(account: string, remote: PrivateSpaceRecord, version: number) {
    const owner = requireUnlocked(account);
    if (remote.accountPubkey !== owner || !remote.id || !Number.isSafeInteger(version) || version < 1)
      throw new Error("invalid_private_space_remote_record");
    let changed = false;
    let conflicted = false;
    await this.database.transaction("rw", this.database.accountNotes, async () => {
      const existing = await this.database.accountNotes.get([owner, remote.id]);
      if (existing && Number(existing.cloudVersion || 0) >= version) return;
      if (existing && existing.revision !== Number(existing.syncedRevision || 0)
          && !samePrivateSpaceContents(existing, remote)) {
        // Preserve genuine divergent edits, including tombstones. Identical
        // backup restores are already represented by the remote version.
        const copyId = crypto.randomUUID();
        const now = Date.now();
        await this.database.accountNotes.add({
          ...existing, id: copyId, title: existing.title + "（冲突副本）",
          createdAt: now, updatedAt: now, revision: 1,
          cloudVersion: 0, syncedRevision: 0,
        });
        conflicted = true;
      }
      await this.database.accountNotes.put({
        ...remote, accountPubkey: owner, cloudVersion: version,
        syncedRevision: remote.revision,
      });
      changed = true;
    });
    return { changed, conflicted };
  }

  /**
   * User-initiated import with stable source-derived ID.
   * In one IndexedDB transaction, do not overwrite existing, edited, or trashed imports.
   */
  async importNote(account: string, id: string, title: string, body: string,
    extra: Pick<PrivateSpaceDraft, "source" | "attachments"> = {}):
    Promise<{ record: PrivateSpaceRecord; created: boolean }> {
    const owner = requireUnlocked(account);
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid_private_space_source_id");
    if (title.length > 500 || body.length > 100_000) throw new Error("private_space_size_limit");
    const source = validatePrivateSpaceSource(extra.source);
    const attachments = validatePrivateSpaceAttachments(extra.attachments);
    let result: { record: PrivateSpaceRecord; created: boolean } | undefined;
    await this.database.transaction("rw", this.database.accountNotes, async () => {
      const existing = await this.database.accountNotes.get([owner, id]);
      if (existing) {
        result = { record: existing, created: false };
        return;
      }
      const now = Date.now();
      const record: PrivateSpaceRecord = {
        accountPubkey: owner, id, kind: "note", title, body,
        tasks: [], pinned: false, createdAt: now, updatedAt: now, revision: 1,
        ...(source ? { source } : {}),
        ...(attachments.length ? { attachments } : {}),
      };
      await this.database.accountNotes.add(record);
      result = { record, created: true };
    });
    return result!;
  }

  /**
   * Import a validated same-account backup without overwriting local notes.
   * The entire merge is transactional, including deleted and archived items.
   * Every inserted note is local-dirty so PR2 cloud CAS can reconcile safely.
   */
  async restoreBackup(
    account: string,
    rows: import("@/services/privateSpaceBackup").PrivateBackupNote[],
    isCurrent: () => boolean = () => true,
  ): Promise<{ added: number; skipped: number }> {
    const owner = requireUnlocked(account);
    if (!isCurrent()) throw new Error("account_changed");
    let added = 0;
    let skipped = 0;
    await this.database.transaction("rw", this.database.accountNotes, async () => {
      for (const row of rows) {
        if (!isCurrent() || !isLocalVaultUnlocked(owner)) throw new Error("account_changed");
        const existing = await this.database.accountNotes.get([owner, row.id]);
        if (existing) {
          skipped++;
          continue;
        }
        const now = Date.now();
        await this.database.accountNotes.add({
          accountPubkey: owner, id: row.id, kind: row.kind,
          title: row.title, body: row.body,
          tasks: row.tasks.map(task => ({ ...task })),
          pinned: row.pinned, createdAt: row.createdAt,
          updatedAt: Math.max(now, row.updatedAt),
          revision: Math.max(1, row.revision),
          ...(row.source ? { source: validatePrivateSpaceSource(row.source) } : {}),
          ...(row.attachments ? { attachments: validatePrivateSpaceAttachments(row.attachments) } : {}),
          ...(row.archivedAt === undefined ? {} : { archivedAt: row.archivedAt }),
          ...(row.deletedAt === undefined ? {} : { deletedAt: row.deletedAt }),
          cloudVersion: 0, syncedRevision: 0,
        });
        added++;
      }
      if (!isCurrent() || !isLocalVaultUnlocked(owner)) throw new Error("account_changed");
    });
    return { added, skipped };
  }

  /**
   * PR-FIX-A: atomically materialize an in-memory draft at its first meaningful edit.
   * Never leave behind an empty row if the user opens and dismisses the composer.
   */
  async createWithContent(account: string, id: string, draft: PrivateSpaceDraft): Promise<PrivateSpaceRecord> {
    const owner = requireUnlocked(account);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("invalid_private_space_id");
    const data = validateDraft(draft);
    if (!data.title.trim() && !data.body.trim() && !data.tasks.some(task => task.text.trim()))
      throw new Error("private_space_empty_draft");
    const now = Date.now();
    const record: PrivateSpaceRecord = {
      accountPubkey: owner, id, ...data,
      createdAt: now, updatedAt: now, revision: 1,
    };
    // add (never put) guarantees another writer cannot be overwritten on ID collision.
    await this.database.accountNotes.add(record);
    return record;
  }

  async create(account: string, kind: "note" | "todo"): Promise<PrivateSpaceRecord> {
    const owner = requireUnlocked(account);
    if (kind !== "note" && kind !== "todo") throw new Error("invalid_private_space_kind");
    const now = Date.now();
    const record: PrivateSpaceRecord = {
      accountPubkey: owner,
      id: crypto.randomUUID(),
      kind,
      title: "",
      body: "",
      tasks: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    await this.database.accountNotes.add(record);
    return record;
  }

  async save(account: string, id: string, draft: PrivateSpaceDraft): Promise<PrivateSpaceRecord> {
    const owner = requireUnlocked(account);
    const data = validateDraft(draft);
    return this.update(owner, id, data);
  }

  async update(
    account: string,
    id: string,
    changes: Partial<Pick<PrivateSpaceRecord, "kind" | "title" | "body" | "tasks" | "pinned" | "source" | "attachments" | "archivedAt" | "deletedAt">>,
  ): Promise<PrivateSpaceRecord> {
    const owner = requireUnlocked(account);
    if (!id) throw new Error("invalid_private_space_id");
    let updated: PrivateSpaceRecord | undefined;
    await this.database.transaction("rw", this.database.accountNotes, async () => {
      const existing = await this.database.accountNotes.get([owner, id]);
      if (!existing) throw new Error("private_space_missing");
      if (existing.deletedAt && changes.deletedAt === undefined) throw new Error("private_space_deleted");
      updated = {
        ...existing,
        ...changes,
        accountPubkey: owner,
        id,
        createdAt: existing.createdAt,
        updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
        revision: existing.revision + 1,
      };
      await this.database.accountNotes.put(updated);
    });
    return updated!;
  }

  async moveToTrash(account: string, id: string) {
    return this.update(account, id, { deletedAt: Date.now() });
  }
}

export const privateSpaceRepository = new PrivateSpaceRepository();
