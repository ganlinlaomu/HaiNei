export type TaskPriority = 0 | 1 | 2;

export type ScheduledTask<T> = {
  promise: Promise<T>;
  promote: (priority: TaskPriority) => void;
  cancel: () => void;
  started: () => boolean;
};

type QueueEntry<T> = {
  priority: TaskPriority;
  order: number;
  running: boolean;
  cancelled: boolean;
  run: () => void;
  reject: (reason?: unknown) => void;
};

export function createPrioritizedTaskQueue(maxConcurrency: number) {
  const limit = Math.max(1, Math.floor(maxConcurrency));
  const queue: Array<QueueEntry<unknown>> = [];
  let active = 0;
  let order = 0;

  function drain() {
    while (active < limit && queue.length) {
      queue.sort((a, b) => a.priority - b.priority || a.order - b.order);
      const entry = queue.shift();
      if (!entry || entry.cancelled) continue;
      entry.run();
    }
  }

  function schedule<T>(task: () => Promise<T>, priority: TaskPriority = 1): ScheduledTask<T> {
    let entry!: QueueEntry<T>;
    let resolvePromise!: (value: T | PromiseLike<T>) => void;
    let rejectPromise!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    entry = {
      priority,
      order: order++,
      running: false,
      cancelled: false,
      reject: rejectPromise,
      run: () => {
        if (entry.running || entry.cancelled) return;
        entry.running = true;
        active += 1;
        task().then(resolvePromise, rejectPromise).finally(() => {
          active = Math.max(0, active - 1);
          drain();
        });
      },
    };
    queue.push(entry as QueueEntry<unknown>);
    drain();

    return {
      promise,
      promote(nextPriority) {
        if (entry.running || entry.cancelled || nextPriority >= entry.priority) return;
        entry.priority = nextPriority;
        drain();
      },
      cancel() {
        if (entry.running || entry.cancelled) return;
        entry.cancelled = true;
        const index = queue.indexOf(entry as QueueEntry<unknown>);
        if (index >= 0) queue.splice(index, 1);
        rejectPromise(new DOMException("Aborted", "AbortError"));
        drain();
      },
      started: () => entry.running,
    };
  }

  return {
    schedule,
    snapshot: () => ({ active, queued: queue.filter(entry => !entry.cancelled).length }),
  };
}
