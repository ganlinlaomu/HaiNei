// NIP-77: dzo (strfry) re-sent its whole NIP-59 backdating window (~215 wraps)
// on every launch. Reconciliation sends fingerprints and only missing ids.
import { describe, expect, it } from "vitest";
import { Negentropy, NegentropyStorageVector } from "nostr-tools-nip77";
import { negentropyMissingIds } from "@/nostr/messaging/sync/negentropy";

const id = (n: number) => n.toString(16).padStart(64, "0");
const items = (ns: number[]) => ns.map(n => ({ id: id(n), createdAt: 1_000 + (n % 37) }));

/** A strfry-like relay answering NEG-OPEN/NEG-MSG from its own set. */
function relaySocket(relayItems: Array<{ id: string; createdAt: number }>, behaviour: "ok" | "error" | "silent" = "ok") {
  const storage = new NegentropyStorageVector();
  for (const item of relayItems) storage.insert(item.createdAt, item.id);
  storage.seal();
  const server = new Negentropy(storage);
  const listeners: Record<string, Array<(event: any) => void>> = {};
  const sent: unknown[] = [];
  const emit = (type: string, event: any = {}) => listeners[type]?.forEach(listener => listener(event));
  const socket = {
    sent,
    addEventListener(type: string, listener: (event: any) => void) { (listeners[type] ||= []).push(listener); },
    send(data: string) {
      const message = JSON.parse(data);
      sent.push(message);
      if (message[0] === "NEG-CLOSE" || behaviour === "silent") return;
      if (behaviour === "error") return queueMicrotask(() => emit("message", { data: JSON.stringify(["NEG-ERR", message[1], "blocked: no"]) }));
      const query = message[0] === "NEG-OPEN" ? message[3] : message[2];
      const reply = server.reconcile(query) ?? "61";
      queueMicrotask(() => emit("message", { data: JSON.stringify(["NEG-MSG", message[1], reply]) }));
    },
    close() {},
  };
  queueMicrotask(() => emit("open"));
  return socket;
}

describe("NIP-77 negentropy catch-up", () => {
  it("returns only the wraps the relay has and this device lacks", async () => {
    const all = Array.from({ length: 400 }, (_, n) => n + 1);
    const local = items(all.filter(n => n % 50 !== 0));
    let socket: ReturnType<typeof relaySocket> | null = null;
    const missing = await negentropyMissingIds("wss://dzo", { kinds: [1059] }, [...local, ...items([9_999])], {
      createSocket: () => (socket = relaySocket(items(all))),
    });
    expect(missing?.sort()).toEqual(items(all.filter(n => n % 50 === 0)).map(item => item.id).sort());
    // Fingerprints, not the window: the relay never sent an EVENT.
    expect(socket!.sent[0]).toEqual(["NEG-OPEN", expect.any(String), { kinds: [1059] }, expect.any(String)]);
    expect(socket!.sent.at(-1)).toEqual(["NEG-CLOSE", expect.any(String)]);
  });

  it("is empty when nothing new arrived", async () => {
    const all = items([1, 2, 3]);
    expect(await negentropyMissingIds("wss://dzo", {}, all, { createSocket: () => relaySocket(all) })).toEqual([]);
  });

  it("falls back (null) when the relay refuses, stalls or the sync is aborted", async () => {
    expect(await negentropyMissingIds("wss://dzo", {}, [], { createSocket: () => relaySocket(items([1]), "error") })).toBeNull();
    expect(await negentropyMissingIds("wss://dzo", {}, [], { timeoutMs: 20, createSocket: () => relaySocket(items([1]), "silent") })).toBeNull();
    const controller = new AbortController();
    const pending = negentropyMissingIds("wss://dzo", {}, [], { signal: controller.signal, createSocket: () => relaySocket(items([1]), "silent") });
    controller.abort();
    expect(await pending).toBeNull();
  });
});
