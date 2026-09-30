import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { createChallenge, verifyAndConsumeChallenge } from "../worker/src/auth";
import { createMediaSession } from "../worker/src/media";
import { assertUserAndQuota } from "../worker/src/quota";
import type { Env } from "../worker/src/types";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { signWorkerRequest } from "@/services/workerAuth";
import { join } from "node:path";

class MemoryD1 {
  challenges = new Map<string, { expires_at: number; used_at: number | null; pubkey: string | null }>();
  users = new Map<string, { revoked_at: number | null }>();
  usage = new Map<string, { upload_count: number; upload_bytes: number }>();
  rateLimits = new Map<string, number>();

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    let values: unknown[] = [];
    return {
      bind: (...next: unknown[]) => { values = next; return this.prepareBound(normalized, () => values); },
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
    };
  }

  private prepareBound(sql: string, values: () => unknown[]) {
    return {
      bind: (...next: unknown[]) => this.prepareBound(sql, () => next),
      first: async () => {
        const bound = values();
        if (sql.includes("FROM hainei_auth_challenges")) return this.challenges.get(String(bound[0])) || null;
        if (sql.includes("FROM hainei_users")) return this.users.get(String(bound[0])) || null;
        if (sql.includes("FROM hainei_media_usage")) return this.usage.get(`${bound[0]}|${bound[1]}`) || null;
        return null;
      },
      run: async () => {
        const bound = values();
        if (sql.startsWith("INSERT INTO hainei_rate_limits")) {
          const bucket = String(bound[0]);
          const limit = Number(bound[3]);
          const count = this.rateLimits.get(bucket) || 0;
          if (count >= limit) return { meta: { changes: 0 } };
          this.rateLimits.set(bucket, count + 1);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM hainei_rate_limits") || sql.startsWith("DELETE FROM hainei_auth_challenges")) {
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO hainei_auth_challenges")) {
          this.challenges.set(String(bound[0]), { expires_at: Number(bound[2]), used_at: null, pubkey: null });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE hainei_auth_challenges")) {
          const row = this.challenges.get(String(bound[2]));
          if (!row || row.used_at !== null || row.expires_at <= Number(bound[3])) return { meta: { changes: 0 } };
          row.used_at = Number(bound[0]); row.pubkey = String(bound[1]);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO hainei_users")) {
          const pubkey = String(bound[0]);
          if (!this.users.has(pubkey)) this.users.set(pubkey, { revoked_at: null });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}

function signed(challenge: string, secret: Uint8Array, now: number) {
  return finalizeEvent({
    kind: 27235, created_at: now, content: "Authorize HaiNei media session",
    tags: [["t", "hainei_media_session"], ["challenge", challenge], ["expiration", String(now + 60)]],
  }, secret);
}

function baseEnv(db = new MemoryD1()): Env {
  return {
    DB: db as any,
    BLOSSOM_SERVICE_TOKEN: "server-only-service-token",
    BLOSSOM: { fetch: vi.fn(async () => new Response("not configured", { status: 500 })) },
  };
}

describe("HaiNei Worker authentication and quota", () => {
  it("keeps the long-lived service credential out of frontend sources", () => {
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path); else files.push(path);
      }
    };
    walk(join(process.cwd(), "src"));
    walk(join(process.cwd(), "public"));
    files.push(join(process.cwd(), "index.html"));
    expect(files.every(file => !readFileSync(file, "utf8").includes("BLOSSOM_SERVICE_TOKEN"))).toBe(true);
  });

  it("creates, verifies, consumes, and prevents replay of a signed challenge", async () => {
    const db = new MemoryD1();
    const env = baseEnv(db);
    const secret = generateSecretKey();
    const created = await createChallenge(env, 1000);
    const pubkey = await verifyAndConsumeChallenge(env, created.challenge, signed(created.challenge, secret, 1001), 1001);
    expect(pubkey).toBe(getPublicKey(secret));
    await expect(verifyAndConsumeChallenge(env, created.challenge, signed(created.challenge, secret, 1002), 1002))
      .rejects.toMatchObject({ status: 409, message: "challenge_already_used" });
  });

  it("binds authorization to exact URL, method, and business payload", async () => {
    const db = new MemoryD1();
    const env = baseEnv(db);
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const now = Math.floor(Date.now() / 1000);
    const created = await createChallenge(env, now);
    const payload = { namespace: "settings", ciphertext: "ciphertext-a" };
    const url = "https://worker.test/api/account-state/put";
    const event = await signWorkerRequest(
      async template => finalizeEvent(template, secret),
      pubkey,
      {
        action: "hainei_account_state",
        challenge: created.challenge,
        expiresAt: created.expiresAt,
        url,
        method: "POST",
        payload,
        content: "Authorize test request",
      },
    );

    await expect(verifyAndConsumeChallenge(
      env,
      created.challenge,
      event,
      now + 1,
      "hainei_account_state",
      { url, method: "POST", payload: { ...payload, ciphertext: "tampered" } },
    )).rejects.toMatchObject({ status: 401, message: "auth_payload_mismatch" });

    const second = await createChallenge(env, now + 10);
    const secondEvent = await signWorkerRequest(
      async template => finalizeEvent(template, secret),
      pubkey,
      {
        action: "hainei_account_state",
        challenge: second.challenge,
        expiresAt: second.expiresAt,
        url,
        method: "POST",
        payload,
        content: "Authorize test request",
      },
    );
    await expect(verifyAndConsumeChallenge(
      env,
      second.challenge,
      secondEvent,
      now + 11,
      "hainei_account_state",
      { url: "https://worker.test/api/account-state/get", method: "POST", payload },
    )).rejects.toMatchObject({ status: 401, message: "auth_url_mismatch" });
  });

  it("rejects invalid signatures and expired challenges", async () => {
    const env = baseEnv();
    const secret = generateSecretKey();
    const created = await createChallenge(env, 1000);
    const invalid = { ...JSON.parse(JSON.stringify(signed(created.challenge, secret, 1001))), sig: "0".repeat(128) };
    await expect(verifyAndConsumeChallenge(env, created.challenge, invalid, 1001))
      .rejects.toMatchObject({ status: 401 });
    await expect(verifyAndConsumeChallenge(env, created.challenge, signed(created.challenge, secret, 1301), 1301))
      .rejects.toMatchObject({ status: 410, message: "challenge_expired" });
  });

  it("rejects revoked users, oversized files, and exhausted daily quota", async () => {
    const db = new MemoryD1();
    const pubkey = "a".repeat(64);
    db.users.set(pubkey, { revoked_at: 1 });
    await expect(assertUserAndQuota(baseEnv(db), pubkey, 1, 1000)).rejects.toMatchObject({ status: 403 });
    db.users.set(pubkey, { revoked_at: null });
    await expect(assertUserAndQuota({ ...baseEnv(db), MAX_FILE_SIZE_BYTES: "10" }, pubkey, 11, 1000))
      .rejects.toMatchObject({ status: 413 });
    db.usage.set("a".repeat(64) + "|1970-01-01", { upload_count: 100, upload_bytes: 100 });
    await expect(assertUserAndQuota(baseEnv(db), pubkey, 1, 1000)).rejects.toMatchObject({ status: 429 });
  });

  it("uses the server-side service credential to obtain a scoped Blossom token", async () => {
    const db = new MemoryD1();
    const pubkey = "b".repeat(64);
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("Authorization")).toBe("Bearer server-only-service-token");
      expect(await request.json()).toEqual({ subject: pubkey, ttl: 3600, contentHash: "c".repeat(64), maxBytes: 10 });
      return new Response(JSON.stringify({
        bindingVersion: 1, singleUse: true, contentHash: "c".repeat(64), maxBytes: 10,
        token: "imgbed_upload_user", subject: pubkey, scope: "upload", expiresAt: 9999,
      }), { status: 201 });
    });
    const result = await createMediaSession({ ...baseEnv(db), BLOSSOM: { fetch } }, pubkey, 10, "c".repeat(64));
    expect(result).toEqual({ token: "imgbed_upload_user", pubkey, scope: "upload", expiresAt: 9999 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
