import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nip19 } from "nostr-tools";
import {
  buildNostrProfileQrValue,
  parseNostrProfileQrValue,
  pubkeyToNpub,
  shortNpub,
} from "@/utils/nostrQr";

const PUBKEY = "11".repeat(32);

describe("Nostr QR friend discovery", () => {
  it("encodes public keys as interoperable nostr:npub URIs", () => {
    const npub = pubkeyToNpub(PUBKEY);
    expect(npub.startsWith("npub1")).toBe(true);
    expect(buildNostrProfileQrValue(PUBKEY)).toBe(`nostr:${npub}`);
    expect(shortNpub(PUBKEY)).toContain("…");
  });

  it("parses nostr:npub, plain npub and hex while rejecting secret keys", () => {
    const npub = nip19.npubEncode(PUBKEY);
    const nsec = nip19.nsecEncode(new Uint8Array(32).fill(1));
    expect(parseNostrProfileQrValue(`nostr:${npub}`)).toBe(PUBKEY);
    expect(parseNostrProfileQrValue(npub)).toBe(PUBKEY);
    expect(parseNostrProfileQrValue(PUBKEY.toUpperCase())).toBe(PUBKEY);
    expect(parseNostrProfileQrValue(nsec)).toBeNull();
    expect(parseNostrProfileQrValue(`nostr:${nsec}`)).toBeNull();
    expect(parseNostrProfileQrValue("https://example.com/not-a-key")).toBeNull();
  });

  it("keeps QR generation and camera scanning local to the app", () => {
    const myQr = readFileSync(join(process.cwd(), "src/components/MyQrCodeSheet.vue"), "utf8");
    const scanner = readFileSync(join(process.cwd(), "src/components/QrScannerSheet.vue"), "utf8");
    expect(myQr).toContain('qrcode(0, "M")');
    expect(myQr).toContain("buildNostrProfileQrValue");
    expect(myQr).not.toContain("http://");
    expect(myQr).not.toContain("https://");
    expect(scanner).toContain('import("@zxing/browser")');
    expect(scanner).toContain("decodeFromVideoDevice");
    expect(scanner).toContain("decodeFromImageUrl");
    expect(scanner).toContain("controls?.stop?.()");
    expect(scanner).toContain("getTracks().forEach(track => track.stop())");
    expect(scanner).toContain('document.visibilityState === "hidden"');
  });

  it("exposes copy-public-key and QR actions on accepted friend profiles", () => {
    const profile = readFileSync(join(process.cwd(), "src/views/Profile.vue"), "utf8");
    const qr = readFileSync(join(process.cwd(), "src/components/MyQrCodeSheet.vue"), "utf8");
    expect(profile).toContain('aria-label="复制用户公钥"');
    expect(profile).toContain('aria-label="打开用户二维码"');
    expect(profile).toContain("pubkeyToNpub(ownerPubkey.value)");
    expect(profile).toContain('ui.addToast("已复制 npub 公钥"');
    expect(profile).toContain("<MyQrCodeSheet");
    expect(profile).toContain('dialog-label="用户二维码"');
    expect(profile).toContain('hint="扫描二维码即可识别此用户"');
    expect(qr).toContain(':aria-label="dialogLabel"');
    expect(qr).toContain("{{ hint }}");
  });

  it("exposes QR sharing from My and scanning from the existing friend request flow", () => {
    const settings = readFileSync(join(process.cwd(), "src/views/Settings.vue"), "utf8");
    const myProfile = readFileSync(join(process.cwd(), "src/views/MyProfile.vue"), "utf8");
    const friends = readFileSync(join(process.cwd(), "src/views/Friends.vue"), "utf8");
    expect(settings).toContain('aria-label="打开我的二维码"');
    expect(settings).toContain("pubkeyToNpub(keyStore.pkHex)");
    expect(settings).toContain("MyQrCodeSheet");
    expect(myProfile).toContain(">我的二维码</button>");
    expect(friends).toContain("QrScannerSheet");
    expect(friends).toContain('aria-label="扫描二维码添加好友"');
    expect(friends).toContain("const startScan = () =>");
    expect(friends).toContain("parseNostrProfileQrValue");
    expect(friends).toContain('state === "accepted"');
    expect(friends).toContain('state === "incoming_pending"');
    expect(friends).toContain('state === "outgoing_pending"');
    expect(friends).toContain("await friendships.sendRequest(hexKey)");
    expect(friends).toContain("不能添加自己为好友");
    expect(friends).toContain("（可选）");
    expect(friends).toContain('|| `${hexKey.slice(0, 8)}…`');
  });
});
