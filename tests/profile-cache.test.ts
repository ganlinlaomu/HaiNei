import { afterEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { getCachedProfile, localProfileName, parseProfileEvent, profileDisplayName } from "@/services/profileCache";

const ACCOUNT_A = "c".repeat(64);
const ACCOUNT_B = "d".repeat(64);
const PUBKEY = "e".repeat(64);

afterEach(() => vi.unstubAllGlobals());

describe("profile cache", () => {
  it("parses display_name and safe picture metadata", () => {
    const event = {
      pubkey: PUBKEY,
      kind: 0,
      created_at: 123,
      content: JSON.stringify({ display_name: "海内用户", name: "fallback", picture: "https://example.com/avatar.png" })
    } as NostrEvent;
    expect(parseProfileEvent(event, 456)).toMatchObject({
      pubkey: PUBKEY,
      displayName: "海内用户",
      picture: "https://example.com/avatar.png",
      profileUpdatedAt: 123,
      fetchedAt: 456
    });
  });

  it("keeps persisted profiles isolated by account", () => {
    const data = new Map<string, string>([
      [`nostr_profiles_${ACCOUNT_A}`, JSON.stringify([{ pubkey: PUBKEY, displayName: "账户 A", fetchedAt: 1 }])],
      [`nostr_profiles_${ACCOUNT_B}`, JSON.stringify([{ pubkey: PUBKEY, displayName: "账户 B", fetchedAt: 1 }])]
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value)
    });
    expect(getCachedProfile(ACCOUNT_A, PUBKEY)?.displayName).toBe("账户 A");
    expect(getCachedProfile(ACCOUNT_B, PUBKEY)?.displayName).toBe("账户 B");
  });

  it("always prefers a local friend nickname", () => {
    expect(profileDisplayName(ACCOUNT_A, PUBKEY, "家人备注")).toBe("家人备注");
    expect(localProfileName(PUBKEY, `${PUBKEY.slice(0, 8)}…`)).toBe("");
  });
});
