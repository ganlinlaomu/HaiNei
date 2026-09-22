import { createChallenge, verifyAndConsumeChallenge } from "./auth";
import { createMediaSession } from "./media";
import {
  getPushPublicKey,
  removePushSubscription,
  savePushSubscription,
  triggerGenericPush,
} from "./push";
import { HttpError, type Env } from "./types";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function body(request: Request) {
  try { return await request.json() as Record<string, unknown>; }
  catch { throw new HttpError(400, "invalid_json"); }
}

export async function handleRequest(request: Request, env: Env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    if (path === "/api/auth/challenge") return json(await createChallenge(env), 201);
    if (path === "/api/media/session") {
      const payload = await body(request);
      const pubkey = await verifyAndConsumeChallenge(env, payload.challenge, payload.event);
      return json(await createMediaSession(env, pubkey, payload.fileSize), 201);
    }
    if (path === "/api/push/public-key") return json(getPushPublicKey(env));
    if (path === "/api/push/subscribe") {
      const payload = await body(request);
      const pubkey = await verifyAndConsumeChallenge(env, payload.challenge, payload.event, undefined, "hainei_push");
      return json(await savePushSubscription(env, pubkey, payload.subscription), 201);
    }
    if (path === "/api/push/unsubscribe") {
      const payload = await body(request);
      const pubkey = await verifyAndConsumeChallenge(env, payload.challenge, payload.event, undefined, "hainei_push");
      return json(await removePushSubscription(env, pubkey, payload.endpoint));
    }
    if (path === "/api/push/trigger") {
      const payload = await body(request);
      const pubkey = await verifyAndConsumeChallenge(env, payload.challenge, payload.event, undefined, "hainei_push");
      return json(await triggerGenericPush(env, pubkey, payload.recipientPubkeys));
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error("HaiNei Worker request failed", error);
    const status = error instanceof HttpError ? error.status : 500;
    return json({ error: error instanceof Error ? error.message : "internal_error" }, status);
  }
}

export default { fetch: handleRequest };
