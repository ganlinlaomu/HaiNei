import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const ACCOUNT = "a".repeat(64);
const mocks = vi.hoisted(() => ({
  key: { pkHex: "a".repeat(64), supportsNip44: true, nip44Encrypt: vi.fn(), signEvent: vi.fn() },
  list: vi.fn(),
  putLatest: vi.fn()
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/repositories/profileRepository", () => ({
  profileRepository: { list: mocks.list, putLatest: mocks.putLatest }
}));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: vi.fn() }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => [] }));

import { useProfilesStore } from "@/stores/profiles";

describe("profile editor save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mocks.key.pkHex = ACCOUNT;
    mocks.list.mockResolvedValue([]);
    mocks.putLatest.mockResolvedValue(true);
  });

  it("saves nickname, bio and the existing private avatar locally", async () => {
    const profiles = useProfilesStore();
    await profiles.load(ACCOUNT);
    const saved = await profiles.saveOwnProfile({
      nickname: " 88 ",
      bio: " 私密简介 ",
      avatar: "blossom+aesgcm:private-avatar"
    }, 123);

    expect(saved).toEqual({
      ownerPubkey: ACCOUNT,
      nickname: "88",
      bio: "私密简介",
      avatar: "blossom+aesgcm:private-avatar",
      updatedAt: 123
    });
    expect(mocks.putLatest).toHaveBeenCalledWith(ACCOUNT, saved);
    expect(profiles.getProfile(ACCOUNT)).toEqual(saved);
  });
});
