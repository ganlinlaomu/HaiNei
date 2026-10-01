export type MessageSearchCursor = { createdAt: number; id: string };

export type MessageSearchScanProgress = {
  scanned: number;
  complete: boolean;
};

export type MessageSearchScanOptions<T extends MessageSearchCursor> = {
  batchSize: number;
  signal?: AbortSignal;
  shouldContinue: () => boolean;
  loadPage: (before: MessageSearchCursor | undefined, limit: number) => Promise<T[]>;
  onPage: (records: T[], progress: MessageSearchScanProgress) => void | Promise<void>;
};

export async function scanMessageSearchPages<T extends MessageSearchCursor>(
  options: MessageSearchScanOptions<T>,
): Promise<{ scanned: number; complete: boolean; cancelled: boolean }> {
  const batchSize = Math.max(1, options.batchSize);
  let before: MessageSearchCursor | undefined;
  let scanned = 0;

  while (!options.signal?.aborted && options.shouldContinue()) {
    const records = await options.loadPage(before, batchSize);
    if (options.signal?.aborted || !options.shouldContinue()) {
      return { scanned, complete: false, cancelled: true };
    }

    scanned += records.length;
    const complete = records.length < batchSize || records.length === 0;
    await options.onPage(records, { scanned, complete });
    if (complete) return { scanned, complete: true, cancelled: false };

    const oldest = records[0];
    const next = oldest ? { createdAt: oldest.createdAt, id: oldest.id } : undefined;
    if (!next) return { scanned, complete: true, cancelled: false };
    if (before && before.createdAt === next.createdAt && before.id === next.id) {
      return { scanned, complete: true, cancelled: false };
    }
    before = next;
  }

  return { scanned, complete: false, cancelled: true };
}
