import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NEARBY_MAX_BATCH_BYTES,
  batchBytes,
  defaultDeviceName,
  ownDevicesRoom,
  pairingLink,
  parsePairing,
  randomPairingRoom,
  sanitizeOffer,
} from "@/services/nearbyTransfer";

const KEY_A = "1".repeat(64);
const KEY_B = "2".repeat(64);

describe("附近传输 rooms", () => {
  it("puts every device of one account in the same secret room, and other accounts elsewhere", async () => {
    const first = await ownDevicesRoom(KEY_A);
    expect(await ownDevicesRoom(KEY_A.toUpperCase())).toEqual(first);
    expect(await ownDevicesRoom(KEY_B)).not.toEqual(first);
    // Neither the room nor its password reveals the key or each other.
    expect(first.roomId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.password).not.toBe(first.roomId);
    expect(first.roomId).not.toContain(KEY_A);
    await expect(ownDevicesRoom("not-a-key")).rejects.toThrow();
  });

  it("round-trips one-time pairing links", () => {
    const room = randomPairingRoom();
    expect(room.roomId).toMatch(/^[0-9a-f]{32}$/);
    expect(randomPairingRoom()).not.toEqual(room);
    const link = pairingLink(room, "https://hainei.example");
    expect(link).toBe(`https://hainei.example/#/nearby?pair=${room.roomId}.${room.password}`);
    expect(parsePairing(link)).toEqual(room);
    expect(parsePairing(`${room.roomId}.${room.password}`)).toEqual(room);
    expect(parsePairing("nostr:npub1abc")).toBeNull();
  });

  it("names devices in everyday words", () => {
    expect(defaultDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(defaultDeviceName("Mozilla/5.0 (Linux; Android 15) Mobile")).toBe("Android 手机");
    expect(defaultDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows 电脑");
    expect(defaultDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe("Mac");
    expect(defaultDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("iPad");
  });
});

describe("incoming offers", () => {
  it("accepts well-formed offers and strips path separators from names", () => {
    const offer = sanitizeOffer({ id: "0123456789abcdef", files: [{ name: "../照片/a.jpg", size: 10, type: "image/jpeg" }] }, "peer");
    expect(offer).toEqual({ id: "0123456789abcdef", from: "peer", files: [{ name: ".._照片_a.jpg", size: 10, type: "image/jpeg" }] });
  });

  it("rejects malformed offers", () => {
    expect(sanitizeOffer(null, "peer")).toBeNull();
    expect(sanitizeOffer({ id: "short", files: [{ name: "a", size: 1 }] }, "peer")).toBeNull();
    expect(sanitizeOffer({ id: "0123456789abcdef", files: [] }, "peer")).toBeNull();
  });

  it("caps one batch at 1GB for iPhone memory", () => {
    expect(NEARBY_MAX_BATCH_BYTES).toBe(1024 * 1024 * 1024);
    expect(batchBytes([{ size: 600 * 1024 * 1024 }, { size: 500 * 1024 * 1024 }])).toBeGreaterThan(NEARBY_MAX_BATCH_BYTES);
  });

  it("asks before receiving and refuses bytes that were not accepted", () => {
    const service = readFileSync("src/services/nearbyTransfer.ts", "utf8");
    expect(service).toContain('kind: "request"');
    expect(service).toContain("return !!entry && entry.from === peerId && !!announced && byteLength <= announced.size + 1024;");
  });
});

describe("integration", () => {
  it("is reachable without an account, linked from 我的, and loads Trystero lazily", () => {
    const router = readFileSync("src/router/index.ts", "utf8");
    expect(router).toContain('const NearbyTransfer = () => import("@/views/NearbyTransfer.vue");');
    expect(router).toMatch(/path: "\/nearby",[\s\S]{0,80}requiresAuth: false/);
    expect(readFileSync("src/views/Settings.vue", "utf8")).toContain("router.push('/nearby')");
    const service = readFileSync("src/services/nearbyTransfer.ts", "utf8");
    expect(service).toContain('await import("trystero")');
    expect(service).not.toMatch(/^import \{[^}]*\} from "trystero";/m);
  });
});

describe("rediscovery after leaving and coming back", () => {
  it("keeps rooms joined for the app session instead of leaving with the page", () => {
    const page = readFileSync("src/views/NearbyTransfer.vue", "utf8");
    // The page may clean up its own timers, but never leaves a room on unmount.
    const unmount = page.slice(page.indexOf("onBeforeUnmount("), page.indexOf("});", page.indexOf("onBeforeUnmount(")));
    expect(unmount).not.toMatch(/leave|stop/i);
    expect(page).not.toMatch(/\.leave\(\)/);
    const session = readFileSync("src/services/nearbySession.ts", "utf8");
    expect(session).toContain('if (rooms.own && nearbyState.ownAccount === normalized) return;');
    // Rooms are dropped together with the account.
    expect(readFileSync("src/stores/keys.ts", "utf8")).toContain('import("@/services/nearbySession").then(({ resetNearby }) => resetNearby())');
  });

  it("exchanges device names both ways and re-greets peers it cannot name yet", () => {
    const service = readFileSync("src/services/nearbyTransfer.ts", "utf8");
    expect(service).toContain("if (!data?.reply || !wasKnown) void this.sendHello?.(true, peerId);");
    expect(service).toContain("if (!this.names[peerId]) this.names[peerId] = NEARBY_UNNAMED_PEER;");
    expect(service).toContain("if (name === NEARBY_UNNAMED_PEER) void this.sendHello?.(false, peerId);");
  });

  it("points people to the page when an offer arrives elsewhere", () => {
    const session = readFileSync("src/services/nearbySession.ts", "utf8");
    expect(session).toContain("想发送 ${pending.offer.files.length} 个文件，请打开「我的 › 附近传输」确认");
  });
});

describe("half-open relay sockets", () => {
  it("recycles sockets on resume or explicit search without interrupting negotiation every 30 seconds", () => {
    const service = readFileSync("src/services/nearbyTransfer.ts", "utf8");
    expect(service).toContain("const { getRelaySockets } = await import(\"trystero\");");
    expect(service).toContain("socket.close();");
    const session = readFileSync("src/services/nearbySession.ts", "utf8");
    expect(session).toContain("stopResumeWatch = onAppResume(() => refreshNearbyDiscovery());");
    expect(session).not.toContain("NEARBY_RELAY_REFRESH_MS");
    expect(session).not.toMatch(/setInterval\([\s\S]{0,160}refreshNearbyDiscovery/);
    // Entering the page announces this visit on fresh sockets.
    expect(readFileSync("src/views/NearbyTransfer.vue", "utf8")).toMatch(/onMounted\(\(\) => \{[\s\S]{0,140}refreshNearbyDiscovery\(\);/);
  });
});

describe("diagnostics", () => {
  it("shows comparable room fingerprints and connection states, plus a manual re-search", () => {
    const page = readFileSync("src/views/NearbyTransfer.vue", "utf8");
    expect(page).toContain("<summary>诊断信息</summary>");
    expect(page).toContain("房间指纹");
    expect(page).toContain('"重新搜索"');
    const service = readFileSync("src/services/nearbyTransfer.ts", "utf8");
    expect(service).toContain("export async function roomFingerprint(roomId: string)");
    expect(service).toContain("onJoinError: ({ error }) => this.handlers.onError(error)");
    expect(page).toContain("连接错误");
    expect(page).toContain("本次连接协商未完成");
    expect(page).not.toContain("当前网络可能需要 TURN 中继");
  });
});

describe("clock-skew tolerant discovery", () => {
  it("waits for relay catch-up before announcing or accepting signaling", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const patcher = readFileSync("scripts/patch-trystero-nostr.js", "utf8");
    expect(packageJson.scripts.postinstall).toBe("node scripts/patch-trystero-nostr.js");
    expect(patcher).toContain("const subscriptionLookbackSec = 60;");
    expect(patcher).toContain("since: now() - subscriptionLookbackSec,");
    expect(patcher).toContain("const since = now() - subscriptionLookbackSec;");
    const installedNostr = readFileSync("node_modules/@trystero-p2p/nostr/dist/index.mjs", "utf8");
    expect(installedNostr).toContain("since: now() - subscriptionLookbackSec,");
    expect(installedNostr).toContain("const since = now() - subscriptionLookbackSec;");
    expect(installedNostr).toContain("if (topicTag?.[1] && isSubscriptionLive(batcher, subId))");
    expect(installedNostr).toContain("if (isAnnouncement && !canPublishAnnouncement(batchers[client.url]))");
    expect(installedNostr).toContain("if (isAnnouncement && (!canPublishAnnouncement(batchers[client.url])");
    expect(installedNostr).toContain("if (batcher && finishSubscriptionCatchup(batcher, subId))");
    expect(installedNostr).toContain('batcher.subIds.forEach((subId) => client.send(toJson(["CLOSE", subId])));');
    expect(installedNostr).toContain("const subId = batcher.subIds[i] = genId(64);");

    const helpersSource = installedNostr.match(
      /const isSubscriptionLive[^\n]+\nconst canPublishAnnouncement[^\n]+\nconst finishSubscriptionCatchup[^\n]+/,
    )?.[0];
    expect(helpersSource).toBeTruthy();
    const helpers = Function(
      `${helpersSource}; return { isSubscriptionLive, canPublishAnnouncement, finishSubscriptionCatchup };`,
    )() as {
      isSubscriptionLive: (batcher: { pendingEose: Set<string> }, subId: string) => boolean;
      canPublishAnnouncement: (batcher?: { pendingEose: Set<string> }) => boolean;
      finishSubscriptionCatchup: (batcher: { pendingEose: Set<string> }, subId: string) => boolean;
    };

    const batcher = { pendingEose: new Set(["root-sub", "signal-sub"]) };
    // A replayed announcement and old SDP/ICE are all ignored before EOSE.
    expect(helpers.isSubscriptionLive(batcher, "root-sub")).toBe(false);
    expect(helpers.isSubscriptionLive(batcher, "signal-sub")).toBe(false);
    expect(helpers.canPublishAnnouncement(batcher)).toBe(false);
    // Announce only after every chunk in the batch has finished catch-up.
    expect(helpers.finishSubscriptionCatchup(batcher, "root-sub")).toBe(false);
    expect(helpers.canPublishAnnouncement(batcher)).toBe(false);
    expect(helpers.finishSubscriptionCatchup(batcher, "signal-sub")).toBe(true);
    expect(helpers.canPublishAnnouncement(batcher)).toBe(true);
    expect(helpers.isSubscriptionLive(batcher, "signal-sub")).toBe(true);
    // Reconnect starts a new catch-up boundary and blocks replay again.
    batcher.pendingEose.add("signal-sub");
    expect(helpers.isSubscriptionLive(batcher, "signal-sub")).toBe(false);
    expect(helpers.canPublishAnnouncement(batcher)).toBe(false);
  });
});
