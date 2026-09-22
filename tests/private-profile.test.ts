import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { createHomeMessageHandler } from "@/nostr/messaging/homeDelivery";
import { encodeHaiNeiProfilePayload, HAI_NEI_PROFILE_TAGS } from "@/nostr/messaging/privateProfile";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { ProfileRepository } from "@/repositories/profileRepository";
import {
  acceptedProfileRecipients,
  privateProfileDisplayName,
  profileAvatarInitial,
  validatedProfileForAccount
} from "@/stores/profiles";

const ACCOUNT = "a".repeat(64);
const FRIEND = "b".repeat(64);
const STRANGER = "c".repeat(64);
let sequence = 0;
const databases: HaiNeiDatabase[] = [];

function database() {
  const value = new HaiNeiDatabase(`private-profile-${sequence++}`);
  databases.push(value);
  return value;
}

function profileMessage(sender = FRIEND, updatedAt = 100, nickname = "朋友"): CanonicalMessage {
  return {
    id: `profile-${sender}-${updatedAt}`,
    senderPubkey: sender,
    recipientPubkeys: [ACCOUNT],
    plaintext: encodeHaiNeiProfilePayload({ ownerPubkey: sender, nickname, bio: "私密简介", updatedAt }),
    createdAt: 100,
    protocol: "nip17",
    transportKind: 1059,
    tags: HAI_NEI_PROFILE_TAGS
  };
}

afterEach(async () => {
  const active = databases.splice(0);
  const names = active.map(item => item.name);
  active.forEach(item => item.close());
  await Promise.all(names.map(name => Dexie.delete(name)));
});

describe("HaiNei private profiles", () => {
  it("routes a profile update without adding a Home item or notification", async () => {
    const mirror = vi.fn();
    const notify = vi.fn();
    const processProfile = vi.fn(() => true);
    const handler = createHomeMessageHandler({
      accountPubkey: ACCOUNT,
      currentAccount: () => ACCOUNT,
      isAcceptedMessage: () => true,
      processFriendshipMessage: () => false,
      notifyFriendshipMessage: notify,
      processProfileMessage: processProfile,
      isInteraction: () => false,
      processInteraction: () => {},
      mirrorMessage: mirror
    });
    expect(await handler(profileMessage(), { source: "realtime" })).toBe(false);
    expect(processProfile).toHaveBeenCalledOnce();
    expect(mirror).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("stores an owner's update and ignores stale or duplicate timestamps", async () => {
    const repository = new ProfileRepository(database());
    const newest = validatedProfileForAccount(profileMessage(FRIEND, 200, "新版"), ACCOUNT, pk => pk === FRIEND)!;
    const stale = validatedProfileForAccount(profileMessage(FRIEND, 100, "旧版"), ACCOUNT, pk => pk === FRIEND)!;
    expect(await repository.putLatest(ACCOUNT, newest)).toBe(true);
    expect(await repository.putLatest(ACCOUNT, stale)).toBe(false);
    expect(await repository.putLatest(ACCOUNT, newest)).toBe(false);
    expect(await repository.get(ACCOUNT, FRIEND)).toMatchObject({ nickname: "新版", updatedAt: 200 });
  });

  it("distributes only to accepted friends", () => {
    const records = [
      { accountPubkey: ACCOUNT, peerPubkey: FRIEND, state: "accepted" as const, updatedAt: 1 },
      { accountPubkey: ACCOUNT, peerPubkey: STRANGER, state: "outgoing_pending" as const, updatedAt: 1 }
    ];
    expect(acceptedProfileRecipients(records)).toEqual([FRIEND]);
    expect(acceptedProfileRecipients(records)).not.toContain(STRANGER);
  });

  it("prefers a local nickname, then private nickname, then pubkey fallback", () => {
    expect(privateProfileDisplayName("对方昵称", FRIEND, "本地备注")).toBe("本地备注");
    expect(privateProfileDisplayName("对方昵称", FRIEND)).toBe("对方昵称");
    expect(privateProfileDisplayName(undefined, FRIEND)).toBe(`${FRIEND.slice(0, 8)}…`);
  });

  it("provides a letter fallback when no private avatar or nickname exists", () => {
    expect(profileAvatarInitial(undefined, FRIEND)).toBe("B");
  });

  it("keeps cached profiles isolated across account switches", async () => {
    const repository = new ProfileRepository(database());
    await repository.putLatest(ACCOUNT, { ownerPubkey: FRIEND, nickname: "A 的缓存", updatedAt: 1 });
    await repository.putLatest(STRANGER, { ownerPubkey: FRIEND, nickname: "C 的缓存", updatedAt: 2 });
    expect((await repository.get(ACCOUNT, FRIEND))?.nickname).toBe("A 的缓存");
    expect((await repository.get(STRANGER, FRIEND))?.nickname).toBe("C 的缓存");
  });

  it("accepts self-delivered own profile sync without friendship", async () => {
    const repository = new ProfileRepository(database());
    const own = validatedProfileForAccount(profileMessage(ACCOUNT, 300, "我的资料"), ACCOUNT, () => false);
    expect(own).toMatchObject({ ownerPubkey: ACCOUNT, nickname: "我的资料" });
    expect(await repository.putLatest(ACCOUNT, own!)).toBe(true);
    expect(await repository.get(ACCOUNT, ACCOUNT)).toMatchObject({ nickname: "我的资料" });
  });

  it("rejects a non-accepted sender", () => {
    expect(validatedProfileForAccount(profileMessage(STRANGER), ACCOUNT, () => false)).toBeNull();
  });
});
