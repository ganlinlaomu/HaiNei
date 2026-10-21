import { Negentropy, NegentropyStorageVector } from "nostr-tools-nip77";

type SocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
};

export type NegentropyOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  createSocket?: (url: string) => SocketLike;
};

const FRAME_SIZE_LIMIT = 60_000;

/**
 * NIP-77 set reconciliation: compare the (timestamp, id) pairs this device
 * already processed with what the relay holds for `filter`, and return the ids
 * the relay has that this device lacks. Unlike a REQ over the NIP-59 two-day
 * backdating window, only fingerprints and the missing ids cross the network.
 * Returns null when the relay refuses, errors or times out, so callers can fall
 * back to a regular catch-up.
 */
export function negentropyMissingIds(
  url: string,
  filter: Record<string, unknown>,
  local: Array<{ id: string; createdAt: number }>,
  options: NegentropyOptions = {},
): Promise<string[] | null> {
  return new Promise(resolve => {
    let settled = false;
    let socket: SocketLike | null = null;
    const subId = `neg-${Math.random().toString(36).slice(2, 10)}`;
    const missing: string[] = [];
    const finish = (result: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (socket) {
        try { if (result) socket.send(JSON.stringify(["NEG-CLOSE", subId])); } catch { /* closing anyway */ }
        try { socket.close(); } catch { /* already closed */ }
      }
      resolve(result);
    };
    const abort = () => finish(null);
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? 8_000);
    if (options.signal?.aborted) return finish(null);
    options.signal?.addEventListener("abort", abort, { once: true });

    let negentropy: Negentropy;
    try {
      const storage = new NegentropyStorageVector();
      for (const item of local) storage.insert(item.createdAt, item.id);
      storage.seal();
      negentropy = new Negentropy(storage, FRAME_SIZE_LIMIT);
      socket = (options.createSocket ?? (target => new WebSocket(target)))(url);
    } catch {
      return finish(null);
    }
    socket.addEventListener("open", () => {
      try {
        socket!.send(JSON.stringify(["NEG-OPEN", subId, filter, negentropy.initiate()]));
      } catch {
        finish(null);
      }
    });
    socket.addEventListener("message", event => {
      let data: unknown;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      if (!Array.isArray(data) || data[1] !== subId) return;
      if (data[0] === "NEG-ERR") return finish(null);
      if (data[0] !== "NEG-MSG" || typeof data[2] !== "string") return;
      try {
        const next = negentropy.reconcile(data[2], undefined, id => { missing.push(id); });
        if (next) socket!.send(JSON.stringify(["NEG-MSG", subId, next]));
        else finish(missing);
      } catch {
        finish(null);
      }
    });
    socket.addEventListener("close", () => finish(null));
    socket.addEventListener("error", () => finish(null));
  });
}
