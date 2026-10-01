export type QueuedTask<T> = {
  readonly promise: Promise<T>;
  readonly started: boolean;
  promote(priority: number): void;
  cancel(reason?: unknown): void;
};

type QueueEntry = {
  priority: number;
  order: number;
  started: boolean;
  settled: boolean;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

export class PriorityTaskQueue {
  private readonly pending: QueueEntry[] = [];
  private active = 0;
  private sequence = 0;

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("PriorityTaskQueue concurrency must be at least 1");
    }
  }

  enqueue<T>(task: () => Promise<T>, priority = 1): QueuedTask<T> {
    let entry!: QueueEntry;
    const promise = new Promise<T>((resolve, reject) => {
      entry = {
        priority,
        order: this.sequence++,
        started: false,
        settled: false,
        run: async () => task(),
        resolve: value => resolve(value as T),
        reject,
      };
    });

    this.pending.push(entry);
    const handle: QueuedTask<T> = {
      promise,
      get started() {
        return entry.started;
      },
      promote: nextPriority => {
        if (entry.started || entry.settled || nextPriority >= entry.priority) return;
        entry.priority = nextPriority;
        this.drain();
      },
      cancel: reason => {
        if (entry.started || entry.settled) return;
        entry.settled = true;
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        entry.reject(reason ?? abortError());
        this.drain();
      },
    };

    this.drain();
    return handle;
  }

  private drain() {
    while (this.active < this.concurrency && this.pending.length) {
      this.pending.sort((a, b) => a.priority - b.priority || a.order - b.order);
      const entry = this.pending.shift();
      if (!entry || entry.settled) continue;

      entry.started = true;
      this.active += 1;
      Promise.resolve()
        .then(entry.run)
        .then(
          value => {
            if (entry.settled) return;
            entry.settled = true;
            entry.resolve(value);
          },
          error => {
            if (entry.settled) return;
            entry.settled = true;
            entry.reject(error);
          },
        )
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.drain();
        });
    }
  }
}
