import { db, type HaiNeiDatabase, type PrivateSpaceRecord, type PrivateSpaceTask } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";
import { isLocalVaultUnlocked } from "@/services/localVault";

export type PrivateSpaceDraft = Pick<PrivateSpaceRecord, "kind" | "title" | "body" | "tasks" | "pinned">;

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
  return { kind: draft.kind, title: draft.title, body: draft.body, tasks, pinned: !!draft.pinned };
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
    changes: Partial<Pick<PrivateSpaceRecord, "kind" | "title" | "body" | "tasks" | "pinned" | "archivedAt" | "deletedAt">>,
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
