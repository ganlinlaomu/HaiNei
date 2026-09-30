import { createChallenge, verifyAndConsumeChallenge } from "./auth";
import { createMediaSession } from "./media";
import {
  getPushPublicKey,
  removePushSubscription,
  replacePushAuthorizationPolicy,
  savePushSubscription,
  triggerGenericPush,
} from "./push";
import { HttpError, integerSetting, type Env } from "./types";
import { enforceChallengeRateLimit, readJsonBody } from "./requestGuards";
import { AccountStateConflict, getAccountState, putAccountState } from "./accountState";

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

function bodyLimit(env: Env, routeMaximum: number) {
  return Math.min(
    routeMaximum,
    integerSetting(env.MAX_API_BODY_BYTES, 512 * 1024, 16 * 1024, 2 * 1024 * 1024),
  );
}

async function body(request: Request, env: Env, routeMaximum: number) {
  return readJsonBody(request, bodyLimit(env, routeMaximum));
}

function authBinding(request: Request, payload: Record<string, unknown>) {
  const { challenge: _challenge, event: _event, ...businessPayload } = payload;
  return { url: request.url, method: request.method, payload: businessPayload };
}

export async function handleRequest(request: Request, env: Env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    if (path === "/api/auth/challenge") {
      await enforceChallengeRateLimit(env, request);
      return json(await createChallenge(env), 201);
    }
    if (path === "/api/media/session") {
      const payload = await body(request, env, 16 * 1024);
      const pubkey = await verifyAndConsumeChallenge(
        env, payload.challenge, payload.event, undefined, "hainei_media_session", authBinding(request, payload),
      );
      return json(await createMediaSession(env, pubkey, payload.fileSize), 201);
    }
    if (path === "/api/account-state/get") {
      const payload = await body(request, env, 32 * 1024);
      const pubkey = await verifyAndConsumeChallenge(
        env, payload.challenge, payload.event, undefined, "hainei_account_state", authBinding(request, payload),
      );
      return json(await getAccountState(env, pubkey, payload.namespaces, payload.knownVersions));
    }
    if (path === "/api/account-state/put") {
      const payload = await body(request, env, 384 * 1024);
      const pubkey = await verifyAndConsumeChallenge(
        env, payload.challenge, payload.event, undefined, "hainei_account_state", authBinding(request, payload),
      );
      return json(await putAccountState(env, pubkey, payload));
    }
    if (path === "/api/push/public-key") return json(getPushPublicKey(env));
    if (path === "/api/push/subscribe") {
      const payload = await body(request, env, 16 * 1024);
      const pubkey = await verifyAndConsumeChallenge(
        env, payload.challenge, payload.event, undefined, "hainei_push", authBinding(request, payload),
      );
      return json(await savePushSubscription(env, pubkey, payload.subscription), 201);
    }
    if (path === "/api/push/unsubscribe") {
      const payload = await body(request, env, 16 * 1024);
      const pubkey = await verifyAndConsumeChallenge(
        env, payload.challenge, payload.event, undefined, "hainei_push", authBinding(request, payload),
      );
      return json(await removePushSubscription(env, pubkey, payload.endpoint));
    }
    if (path === "/api/push/policy") {
      const payload = await body(request, env, 32 * 1024);
      const pubkey = await verifyAndConsumeChallenge(
        env, payload.challenge, payload.event, undefined, "hainei_push", authBinding(request, payload),
      );
      return json(await replacePushAuthorizationPolicy(env, pubkey, payload.senderPubkeys));
    }
    if (path === "/api/push/trigger") {
      const payload = await body(request, env, 32 * 1024);
      const pubkey = await verifyAndConsumeChallenge(
        env, payload.challenge, payload.event, undefined, "hainei_push", authBinding(request, payload),
      );
      const diagnostics = await triggerGenericPush(env, pubkey, payload.recipientPubkeys, payload.type, payload.messageId);
      console.info({ ...diagnostics, message: "push trigger processed" });
      return json({ accepted: true }, 202);
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof AccountStateConflict) {
      return json({ error: error.message, currentVersion: error.currentVersion }, 409);
    }
    if (!(error instanceof HttpError)) console.error("HaiNei Worker request failed", error);
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError
      ? error.message
      : path.startsWith("/api/push/") ? "push_storage_unavailable" : "internal_error";
    return json({ error: message }, status);
  }
}

export default { fetch: handleRequest };
