import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeVisibleCall, CALL_PUSH_HANDOFF_MS, triggerGenericPush } from "../worker/src/push";
import { handleRequest } from "../worker/src/index";
import type { Env } from "../worker/src/types";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { signWorkerRequest } from "@/services/workerAuth";

const CALLER = "a".repeat(64);
const CALLEE = "b".repeat(64);
const MESSAGE = "c".repeat(64);
const ENDPOINT = "https://web.push.apple.com/device-one";
const OTHER_ENDPOINT = "https://web.push.apple.com/device-two";

// Execute real migrations and SQL: a mock that ignores foreground_until hid
// the original regression in existing push tests.
class SqliteD1 {
  db = new DatabaseSync(":memory:");
  constructor() {
    // Base auth table is owned by the shared Blossom database, not these
    // additive HaiNei migrations.
    this.db.exec(`CREATE TABLE hainei_auth_challenges (
      challenge_hash TEXT PRIMARY KEY, pubkey TEXT, created_at INTEGER,
      expires_at INTEGER, used_at INTEGER
    )`);
    for (const path of ["0002_push_subscriptions.sql", "0004_security_controls.sql", "0007_push_foreground.sql"]) {
      this.db.exec(readFileSync(`worker/migrations/${path}`, "utf8"));
    }
  }
  prepare(sql: string) {
    const statement = this.db.prepare(sql);
    const bound = (values: any[] = []): any => ({
      bind: (...next: any[]) => bound(next),
      first: async () => statement.get(...values) || null,
      all: async () => ({ results: statement.all(...values) }),
      run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } }),
    });
    return bound();
  }
  async batch(statements: any[]) { return Promise.all(statements.map(statement => statement.run())); }
}

let db: SqliteD1;
let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;
let publicKey: string;
let auth: string;
let privateKey: string;

beforeEach(async () => {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64url");
  privateKey = (await crypto.subtle.exportKey("jwk", keys.privateKey)).d!;
  auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  db = new SqliteD1();
  env = { DB: db, VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: "mailto:test@example.com" } as unknown as Env;
  const now = Math.floor(Date.now() / 1000);
  db.db.prepare("INSERT INTO hainei_push_authorizations VALUES (?, ?, ?, ?)").run(CALLEE, CALLER, now + 3600, now);
  addDevice(ENDPOINT, now + 40);
  fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.db.close();
});

function addDevice(endpoint: string, foregroundUntil = 0) {
  const now = Math.floor(Date.now() / 1000);
  db.db.prepare("INSERT INTO hainei_push_subscriptions VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(CALLEE, endpoint, publicKey, auth, now, now, foregroundUntil);
}
async function settleCall(id = MESSAGE) {
  const pending = triggerGenericPush(env, CALLER, [CALLEE], "call", id);
  await vi.advanceTimersByTimeAsync(CALL_PUSH_HANDOFF_MS + 10);
  return pending;
}

describe("per-device incoming-call notification ownership", () => {
  it("pushes despite a stale 40-second foreground lease when the UI does not acknowledge", async () => {
    expect(await settleCall()).toMatchObject({ subscriptionsFound: 1, handled: 0, sent: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Urgency: "high" });
  });

  it("lets the mounted UI acknowledge during the grace window and avoids a system push", async () => {
    const pending = triggerGenericPush(env, CALLER, [CALLEE], "call", MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    expect(await acknowledgeVisibleCall(env, CALLEE, ENDPOINT, CALLER, MESSAGE)).toEqual({ acknowledged: true });
    await vi.advanceTimersByTimeAsync(CALL_PUSH_HANDOFF_MS);
    expect(await pending).toMatchObject({ handled: 1, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("suppresses only the acknowledged device, leaving another device eligible", async () => {
    addDevice(OTHER_ENDPOINT);
    await acknowledgeVisibleCall(env, CALLEE, ENDPOINT, CALLER, MESSAGE);
    expect(await settleCall()).toMatchObject({ subscriptionsFound: 2, handled: 1, sent: 1 });
    expect(fetchMock.mock.calls[0][0]).toBe(OTHER_ENDPOINT);
  });

  it("does not reuse an old call's acknowledgement for a different invite", async () => {
    await acknowledgeVisibleCall(env, CALLEE, ENDPOINT, CALLER, MESSAGE);
    expect(await settleCall("d".repeat(64))).toMatchObject({ handled: 0, sent: 1 });
  });

  it("expires a stale acknowledgement instead of suppressing a late request indefinitely", async () => {
    await acknowledgeVisibleCall(env, CALLEE, ENDPOINT, CALLER, MESSAGE);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await settleCall()).toMatchObject({ handled: 0, sent: 1 });
  });

  it("cannot acknowledge another account's subscription or malformed invite IDs", async () => {
    expect(await acknowledgeVisibleCall(env, "e".repeat(64), ENDPOINT, CALLER, MESSAGE)).toEqual({ acknowledged: false });
    await expect(acknowledgeVisibleCall(env, CALLEE, ENDPOINT, CALLER, "invalid"))
      .rejects.toMatchObject({ status: 400 });
    expect(await settleCall()).toMatchObject({ handled: 0, sent: 1 });
  });

  it("does not bypass recipient authorization or change ordinary message foreground policy", async () => {
    expect(await triggerGenericPush(env, CALLER, [CALLEE], "message", MESSAGE)).toMatchObject({ subscriptionsFound: 0, sent: 0 });
    db.db.exec("DELETE FROM hainei_push_authorizations");
    expect(await triggerGenericPush(env, CALLER, [CALLEE], "call", MESSAGE)).toMatchObject({ subscriptionsFound: 0, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates a retried call after the provider accepted its first push", async () => {
    await settleCall();
    await settleCall();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("authenticates call acknowledgement requests and binds them to their payload", async () => {
    const url = "https://worker.test/api/push/call-handled";
    const secret = generateSecretKey();
    const account = getPublicKey(secret);
    const payload = { endpoint: ENDPOINT, senderPubkey: CALLER, messageId: MESSAGE };
    const event = await signWorkerRequest(async template => finalizeEvent(template, secret), account,
      { action: "hainei_push", url, method: "POST", payload, content: "Claim visible call" });
    const post = (body: unknown) => handleRequest(new Request(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env);
    expect((await post({ ...payload })).status).toBeGreaterThanOrEqual(400);
    const tampered = await post({ ...payload, messageId: "d".repeat(64), event });
    expect(tampered.status).toBe(401);
    const response = await post({ ...payload, event });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acknowledged: false });
  });
});
