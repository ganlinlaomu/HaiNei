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

if (changed) {
  fs.writeFileSync(nostrPath, source);
  console.log("Applied Trystero Nostr clock-skew and replay-safety patch");
} else {
  console.log("Trystero Nostr clock-skew and replay-safety patch already applied");
}
