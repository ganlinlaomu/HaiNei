// Worker requests used to need a separate /api/auth/challenge round trip
// first; startup waited ~1 s on two trips for account state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetWorkerAuthForTests, signedWorkerPost } from "@/services/workerAuth";

const ACCOUNT = "a".repeat(64);
const signEvent = vi.fn(async (template: any) => ({ ...template, pubkey: ACCOUNT, id: "e".repeat(64), sig: "f".repeat(128) }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function post(send: (body: any) => Promise<Response>, challenge = vi.fn(async () => ({ challenge: "c".repeat(64), expiresAt: 2_000_000_000 }))) {
  return { challenge, run: () => signedWorkerPost(signEvent, ACCOUNT, {
    action: "hainei_account_state", url: "https://worker.test/api/account-state/get",
    payload: { namespaces: ["read_state"] }, content: "Authorize", send, challenge,
  }) };
}

beforeEach(() => {
  resetWorkerAuthForTests();
  signEvent.mockClear();
});

describe("single-trip worker auth", () => {
  it("sends one signed request without asking for a challenge", async () => {
    const send = vi.fn(async () => json({ snapshots: [] }));
    const { challenge, run } = post(send);
    expect((await run()).status).toBe(200);
    expect(challenge).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toEqual({ namespaces: ["read_state"], event: expect.any(Object) });
    expect(signEvent.mock.calls[0][0].tags.some((tag: string[]) => tag[0] === "challenge")).toBe(false);
  });

  it("falls back to a challenge on clock skew or an older worker, then keeps using challenges", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(json({ error: "auth_clock_skew" }, 401))
      .mockResolvedValue(json({ snapshots: [] }));
    const first = post(send);
    expect((await first.run()).status).toBe(200);
    expect(first.challenge).toHaveBeenCalledOnce();
    expect(send.mock.calls[1][0]).toMatchObject({ challenge: "c".repeat(64) });
    expect(signEvent.mock.calls[1][0].tags).toContainEqual(["challenge", "c".repeat(64)]);

    // The rest of the session skips the doomed single-trip attempt.
    const second = post(send);
    await second.run();
    expect(second.challenge).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(3);

    resetWorkerAuthForTests();
    const oldWorker = post(vi.fn().mockResolvedValueOnce(json({ error: "invalid_challenge" }, 400)).mockResolvedValue(json({})));
    await oldWorker.run();
    expect(oldWorker.challenge).toHaveBeenCalledOnce();
  });

  it("does not retry other failures", async () => {
    const send = vi.fn(async () => json({ error: "temporary_failure" }, 503));
    const { challenge, run } = post(send);
    expect((await run()).status).toBe(503);
    const forbidden = post(vi.fn(async () => json({ error: "auth_payload_mismatch" }, 401)));
    expect((await forbidden.run()).status).toBe(401);
    expect(challenge).not.toHaveBeenCalled();
    expect(forbidden.challenge).not.toHaveBeenCalled();
  });
});
