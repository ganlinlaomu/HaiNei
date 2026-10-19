#!/usr/bin/env node

/**
 * Trystero 0.26.0 starts Nostr subscriptions at the browser's exact local
 * second. If one device's clock is ahead, the relay correctly filters live
 * announcements from a slower device and the peers never discover each
 * other. Keep a short overlap until this is fixed upstream.
 *
 * Some relays retain Nostr's ephemeral events and replay them before EOSE.
 * A fixed room topic would then receive old announcements and encrypted
 * offer/answer/ICE candidates after reconnecting. Ignore the whole replay,
 * hold our announcement until every subscription has reached EOSE, then
 * announce the current session and negotiate only with live events.
 */

const fs = require("fs");
const path = require("path");

const nostrPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "@trystero-p2p",
  "nostr",
  "dist",
  "index.mjs",
);
const lookbackDeclaration = "const subscriptionLookbackSec = 60;";
const replayGuardDeclaration = "const isSubscriptionLive = (batcher, subId) => !batcher.pendingEose.has(subId);";
const replayGuardHelpers = `${replayGuardDeclaration}
const canPublishAnnouncement = (batcher) => !batcher?.pendingEose.size;
const finishSubscriptionCatchup = (batcher, subId) => batcher.pendingEose.delete(subId) && batcher.pendingEose.size === 0;`;

let source = fs.readFileSync(nostrPath, "utf8");
let changed = false;

function replaceRequired(before, after) {
  if (!source.includes(before)) throw new Error(`Trystero Nostr patch target changed: ${before}`);
  source = source.replace(before, after);
  changed = true;
}

if (!source.includes(lookbackDeclaration)) {
  replaceRequired(
    "const now = () => Math.floor(Date.now() / 1e3);",
    `const now = () => Math.floor(Date.now() / 1e3);\n${lookbackDeclaration}`,
  );
  replaceRequired("since: now(),", "since: now() - subscriptionLookbackSec,");
  replaceRequired("const since = now();", "const since = now() - subscriptionLookbackSec;");
}

// Migrate the first replay fix used during development: allowing historical
// announcements could start an offer before EOSE and race with the live
// answer. A clean EOSE boundary is both simpler and deterministic.
source = source.replace(/const isPeerAnnouncement = \(content\) => \{[\s\S]*?\n\};\n/, "");

if (!source.includes(replayGuardDeclaration)) {
  replaceRequired(
    `${lookbackDeclaration}\nconst topicToKind`,
    `${lookbackDeclaration}\n${replayGuardHelpers}\nconst topicToKind`,
  );
}

const announcementDeferral = "if (isAnnouncement && !canPublishAnnouncement(batchers[client.url])) return nextAnnounce(steadyAnnounceIntervalMs);";
const inactiveRelayGuard = "if (retiredRelays.has(client) || client.isClosed) return isAnnouncement ? stopAnnouncing : void 0;";
const deferralBeforeInactiveRelay = `${announcementDeferral}\n\t${inactiveRelayGuard}`;
if (source.includes(deferralBeforeInactiveRelay)) {
  replaceRequired(
    deferralBeforeInactiveRelay,
    `${inactiveRelayGuard}\n\t${announcementDeferral}`,
  );
} else if (!source.includes(announcementDeferral)) {
  replaceRequired(
    inactiveRelayGuard,
    `${inactiveRelayGuard}\n\t${announcementDeferral}`,
  );
}

const finalAnnouncementGuard = "if (isAnnouncement && (!canPublishAnnouncement(batchers[client.url]) || !batchers[client.url]?.topics.has(topic))) return nextAnnounce(steadyAnnounceIntervalMs);";
if (source.includes("if (isAnnouncement && !batchers[client.url]?.topics.has(topic)) return nextAnnounce(steadyAnnounceIntervalMs);")) {
  replaceRequired(
    "if (isAnnouncement && !batchers[client.url]?.topics.has(topic)) return nextAnnounce(steadyAnnounceIntervalMs);",
    finalAnnouncementGuard,
  );
} else if (!source.includes(finalAnnouncementGuard)) {
  throw new Error("Trystero Nostr final announcement guard target changed");
}

const reusedSubscriptions = `while (batcher.subIds.length > chunks.length) {
\t\tconst subId = batcher.subIds.pop();
\t\tif (subId) client.send(toJson(["CLOSE", subId]));
\t}`;
const rotatedSubscriptions = `batcher.subIds.forEach((subId) => client.send(toJson(["CLOSE", subId])));
\tbatcher.subIds = [];`;
if (source.includes(reusedSubscriptions)) {
  replaceRequired(reusedSubscriptions, rotatedSubscriptions);
} else if (!source.includes(rotatedSubscriptions)) {
  throw new Error("Trystero Nostr subscription rotation target changed");
}

if (source.includes("const subId = batcher.subIds[i] ??= genId(64);")) {
  replaceRequired(
    "const subId = batcher.subIds[i] ??= genId(64);",
    "const subId = batcher.subIds[i] = genId(64);",
  );
} else if (!source.includes("const subId = batcher.subIds[i] = genId(64);")) {
  throw new Error("Trystero Nostr subscription id target changed");
}

if (source.includes("if (topicTag?.[1]) batcher.topics.get(topicTag[1])?.(topicTag[1], payload.content);")) {
  replaceRequired(
    "if (topicTag?.[1]) batcher.topics.get(topicTag[1])?.(topicTag[1], payload.content);",
    "if (topicTag?.[1] && isSubscriptionLive(batcher, subId)) batcher.topics.get(topicTag[1])?.(topicTag[1], payload.content);",
  );
} else if (source.includes("if (topicTag?.[1] && (!batcher.pendingEose.has(subId) || isPeerAnnouncement(payload.content))) batcher.topics.get(topicTag[1])?.(topicTag[1], payload.content);")) {
  replaceRequired(
    "if (topicTag?.[1] && (!batcher.pendingEose.has(subId) || isPeerAnnouncement(payload.content))) batcher.topics.get(topicTag[1])?.(topicTag[1], payload.content);",
    "if (topicTag?.[1] && isSubscriptionLive(batcher, subId)) batcher.topics.get(topicTag[1])?.(topicTag[1], payload.content);",
  );
} else if (!source.includes("if (topicTag?.[1] && isSubscriptionLive(batcher, subId))")) {
  throw new Error("Trystero Nostr replay guard target changed");
}

if (source.includes("if (batcher?.pendingEose.delete(subId) && batcher.pendingEose.size === 0)")) {
  replaceRequired(
    "if (batcher?.pendingEose.delete(subId) && batcher.pendingEose.size === 0)",
    "if (batcher && finishSubscriptionCatchup(batcher, subId))",
  );
}

if (source.includes("if (Date.now() - batcher.requestedAt >= 1e3) replayAnnouncements(client);")) {
  replaceRequired(
    "if (Date.now() - batcher.requestedAt >= 1e3) replayAnnouncements(client);",
    "replayAnnouncements(client);",
  );
} else if (!source.includes("if (batcher && finishSubscriptionCatchup(batcher, subId))")) {
  throw new Error("Trystero Nostr EOSE target changed");
}


// NIP-42: a relay may demand proof of control of the signing key before it
// accepts signaling events. Trystero creates a fresh per-session key already;
// authenticate with that same key, without exposing any HaiNei account secret.
const authHelpers = [
  "const nearbyNip42Challenges = new WeakMap();",
  "const nearbyNip42PendingAcks = new WeakMap();",
  "export const createNearbyNip42AuthEvent = async (challenge, relayUrl) => {",
  "  const payload = {",
  "    kind: 22242,",
  "    tags: [['relay', relayUrl], ['challenge', challenge]],",
  "    created_at: now(),",
  "    content: '',",
  "    pubkey",
  "  };",
  "  const hash = await hashWith('SHA-256', toJson([0, payload.pubkey, payload.created_at, payload.kind, payload.tags, payload.content]));",
  "  return { ...payload, id: toHex(hash), sig: toHex(await schnorr.signAsync(hash, secretKey)) };",
  "};",
  "const handleNearbyNip42Challenge = async (client, challenge) => {",
  "  if (!challenge || challenge.length > 512 || client.isClosed || client.socket.readyState !== 1) return;",
  "  const socket = client.socket;",
  "  const previous = nearbyNip42Challenges.get(client);",
  "  if (previous?.socket === socket && previous.challenge === challenge) return;",
  "  nearbyNip42Challenges.set(client, { socket, challenge });",
  "  try {",
  "    const event = await createNearbyNip42AuthEvent(challenge, client.url);",
  "    if (client.isClosed || client.socket !== socket || socket.readyState !== 1) return;",
  "    nearbyNip42PendingAcks.set(client, { socket, id: event.id });",
  "    client.send(toJson(['AUTH', event]));",
  "  } catch (error) {",
  "    nearbyNip42Challenges.delete(client);",
  "    console.warn('trystero: NIP-42 authentication signing failed', error);",
  "  }",
  "};"
].join("\n");
if (!source.includes("const nearbyNip42PendingAcks = new WeakMap();")) {
  replaceRequired("const topicToKind =", authHelpers + "\nconst topicToKind =");
}

// AUTH frames precede normal EVENT handling. The ACK belongs to the auth
// event, not an announcement, and must recreate REQ + current announcements.
const authFrameHandler = [
  "if (msgType === 'AUTH') {",
  "  if (typeof subId === 'string') void handleNearbyNip42Challenge(client, subId);",
  "  return;",
  "}",
  "const pendingAuth = nearbyNip42PendingAcks.get(client);",
  "if (msgType === 'OK' && pendingAuth?.id === subId) {",
  "  nearbyNip42PendingAcks.delete(client);",
  "  if (payload === true && client.socket === pendingAuth.socket && !client.isClosed) {",
  "    resubscribeOnReconnect(client);",
  "  } else if (payload === false) {",
  "    console.warn('trystero: NIP-42 authentication rejected by relay ' + client.url);",
  "  }",
  "  return;",
  "}"
].join("\n            ");
if (!source.includes("const pendingAuth = nearbyNip42PendingAcks.get(client);")) {
  replaceRequired("if (msgType !== eventMsgType) {", authFrameHandler + "\n            if (msgType !== eventMsgType) {");
}

// A pre-auth REQ/EVENT can be rejected before the AUTH frame is processed.
// Don't permanently retire that socket: retry after successful NIP-42 ACK.
if (source.includes("/^(blocked|restricted|auth-required|pow):/")) {
  replaceRequired("/^(blocked|restricted|auth-required|pow):/", "/^(blocked|restricted|pow):/");
} else if (!source.includes("/^(blocked|restricted|pow):/")) {
  throw new Error("Trystero NIP-42 terminal rejection target changed");
}

if (changed) {
  fs.writeFileSync(nostrPath, source);
  console.log("Applied Trystero Nostr clock-skew, replay-safety and NIP-42 patch");
} else {
  console.log("Trystero Nostr clock-skew and replay-safety patch already applied");
}
