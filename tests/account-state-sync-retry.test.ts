// A scheduled account-state upload (e.g. a DM read cursor) that failed while
// offline was only logged. Nothing retried it, so other devices kept showing
// stale state until this device's next cold start.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/dexie";

const resume = vi.hoisted(() => ({ handlers: new Set<(reason: string) => void>() }));
vi.mock("@/services/appResumeCoordinator", () => ({
  onAppResume: (handler: (reason: string) => void) => {
    resume.handlers.add(handler);
    return () => resume.handlers.delete(handler);
  },
}));

import {
  accountStateSyncRetryStateForTests as retryState,
  resetAccountStateSyncRetriesForTests,
  scheduleAccountStateSync,
  type AccountStateKeys,
} from "@/services/accountStateSync";

const ACCOUNT = "a".repeat(64);

function keys(generation = 1): AccountStateKeys & { sessionGeneration: number } {
  return {
    pkHex: ACCOUNT,
    sessionGeneration: generation,
    supportsNip44: true,
    nip44Encrypt: vi.fn(async (_peer, plaintext) => plaintext),
    nip44Decrypt: vi.fn(async (_peer, ciphertext) => ciphertext),
    signEvent: vi.fn(async event => ({ ...event, id: "e".repeat(64), pubkey: ACCOUNT, sig: "f".repeat(128) } as any)),
  };
}

let online = false;
let putStatus = 200;
const puts: string[] = [];
let inFlight = 0;

function stubWorker() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    inFlight++;
    try {
      if (!online) throw new TypeError("Failed to fetch");
      const path = new URL(url).pathname;
      if (path === "/api/auth/challenge") {
        return new Response(JSON.stringify({ challenge: "c".repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 60 }), { status: 201 });
      }
      const body = JSON.parse(String(init?.body || "{}"));
      puts.push(body.namespace);
      if (putStatus !== 200) return new Response(JSON.stringify({ error: "invalid_account_state_ciphertext" }), { status: putStatus });
      return new Response(JSON.stringify({ namespace: body.namespace, version: 1, updatedAt: Date.now() }), { status: 200 });
    } finally {
      inFlight--;
    }
  }));
}

/** Wait (real macrotasks, no fake-time movement) until a condition holds. */
async function until(condition: () => boolean, label: string) {
  for (let i = 0; i < 5_000; i++) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const idle = () => !retryState().running && inFlight === 0;
const awaitingRetry = () => retryState().namespaces.includes("read_state") && retryState().timerScheduled && idle();

async function fireResume(reason = "online") {
  for (const handler of resume.handlers) handler(reason);
  await until(idle, "resume retry to finish");
}

async function scheduleAndFail(session = keys()) {
  scheduleAccountStateSync(session, "read_state");
  await vi.advanceTimersByTimeAsync(600);
  await until(awaitingRetry, "failed upload to be queued for retry");
  return session;
}

/** Advance through every retry timer, waiting for each round to finish. */
async function runTimers(totalMs: number) {
  let elapsed = 0;
  while (elapsed < totalMs && retryState().timerScheduled) {
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    elapsed += 5 * 60_000;
    await until(idle, "timer retry to finish");
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal("window", { location: { origin: "https://app.test" }, setTimeout, clearTimeout });
  online = false;
  putStatus = 200;
  puts.length = 0;
  inFlight = 0;
  resume.handlers.clear();
  resetAccountStateSyncRetriesForTests();
  await db.open();
  await db.accountStateMirrors.clear();
  stubWorker();
});

afterEach(() => {
  resetAccountStateSyncRetriesForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("account-state sync retry", () => {
  it("retries a failed upload when the app comes back online", async () => {
    await scheduleAndFail();
    expect(puts).toEqual([]);
    online = true;
    await fireResume();
    expect(puts).toEqual(["read_state"]);
    expect(retryState().namespaces).toEqual([]);
  });

  it("retries with backoff even without a resume event", async () => {
    await scheduleAndFail();
    online = true;
    await runTimers(60_000);
    expect(puts).toEqual(["read_state"]);
    expect(retryState()).toMatchObject({ namespaces: [], timerScheduled: false });
  });

  it("stops retrying once the upload succeeds", async () => {
    await scheduleAndFail();
    online = true;
    await fireResume();
    await fireResume("visibilitychange");
    await runTimers(60 * 60_000);
    expect(puts).toEqual(["read_state"]);
  });

  it("does not retry a permanent client error", async () => {
    online = true;
    putStatus = 413;
    scheduleAccountStateSync(keys(), "read_state");
    await vi.advanceTimersByTimeAsync(600);
    await until(() => puts.length === 1 && idle(), "first upload attempt");
    await fireResume();
    await runTimers(60 * 60_000);
    expect(puts).toEqual(["read_state"]);
    expect(retryState().namespaces).toEqual([]);
  });

  it("bounds the backoff timer but still retries on the next resume", async () => {
    await scheduleAndFail();
    await runTimers(48 * 60 * 60_000);
    expect(retryState()).toMatchObject({ namespaces: ["read_state"], timerScheduled: false });
    const attempts = vi.mocked(fetch).mock.calls.length;
    expect(attempts).toBeLessThanOrEqual(10);
    online = true;
    await fireResume();
    expect(puts).toEqual(["read_state"]);
  });

  it("drops pending retries for a stale session", async () => {
    const session = await scheduleAndFail(keys(1));
    session.sessionGeneration = 2; // account locked / switched
    online = true;
    await fireResume();
    await runTimers(60 * 60_000);
    expect(puts).toEqual([]);
    expect(retryState().namespaces).toEqual([]);
  });
});
