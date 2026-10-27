// Switching to the Calls tab flashed every avatar: the tab was remounted on
// each visit and each new ProfileAvatar showed its initial while reading the
// decrypted image back from IndexedDB, then faded it in.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAccountLock } from "@/services/accountLifecycle";
import {
  cachedAvatarObjectUrl,
  clearAvatarObjectUrls,
  forgetAvatarObjectUrl,
  rememberAvatarObjectUrl,
} from "@/utils/avatarObjectUrls";

const ACCOUNT = "a".repeat(64);
let created = 0;
const revoked: string[] = [];

beforeEach(() => {
  created = 0;
  revoked.length = 0;
  vi.stubGlobal("URL", Object.assign(Object.create(URL), {
    createObjectURL: () => `blob:avatar-${++created}`,
    revokeObjectURL: (url: string) => { revoked.push(url); },
  }));
});

afterEach(() => {
  clearAvatarObjectUrls();
  vi.unstubAllGlobals();
});

describe("avatar object URL cache", () => {
  it("lets a remounted avatar reuse the URL already shown, per account and reference", () => {
    const blob = new Blob(["x"]);
    const url = rememberAvatarObjectUrl(ACCOUNT, "ref-1", blob);
    expect(rememberAvatarObjectUrl(ACCOUNT.toUpperCase(), "ref-1", blob)).toBe(url);
    expect(created).toBe(1);
    expect(cachedAvatarObjectUrl(ACCOUNT, "ref-1")).toBe(url);
    expect(cachedAvatarObjectUrl(ACCOUNT, "ref-2")).toBe("");
    expect(cachedAvatarObjectUrl("b".repeat(64), "ref-1")).toBe("");
  });

  it("forgets a URL that failed to render, and only that one", () => {
    const url = rememberAvatarObjectUrl(ACCOUNT, "ref-1", new Blob(["x"]));
    forgetAvatarObjectUrl(ACCOUNT, "ref-1", "blob:other");
    expect(cachedAvatarObjectUrl(ACCOUNT, "ref-1")).toBe(url);
    forgetAvatarObjectUrl(ACCOUNT, "ref-1", url);
    expect(cachedAvatarObjectUrl(ACCOUNT, "ref-1")).toBe("");
    expect(revoked).toEqual([url]);
  });

  it("revokes every cached URL when the account locks", async () => {
    const first = rememberAvatarObjectUrl(ACCOUNT, "ref-1", new Blob(["x"]));
    const second = rememberAvatarObjectUrl(ACCOUNT, "ref-2", new Blob(["y"]));
    await prepareAccountLock(ACCOUNT);
    expect(revoked).toEqual([first, second]);
    expect(cachedAvatarObjectUrl(ACCOUNT, "ref-1")).toBe("");
  });

  it("evicts and revokes the least recently shown URL past the bound", () => {
    const first = rememberAvatarObjectUrl(ACCOUNT, "ref-0", new Blob(["x"]));
    const kept = rememberAvatarObjectUrl(ACCOUNT, "ref-1", new Blob(["x"]));
    cachedAvatarObjectUrl(ACCOUNT, "ref-0");
    for (let i = 2; i <= 300; i++) rememberAvatarObjectUrl(ACCOUNT, `ref-${i}`, new Blob(["x"]));
    expect(revoked).toEqual([kept]);
    expect(cachedAvatarObjectUrl(ACCOUNT, "ref-0")).toBe(first);
  });
});

describe("Calls tab and avatars stay painted across visits", () => {
  it("paints a cached avatar on the first frame without the fade-in", () => {
    const avatar = readFileSync("src/components/ProfileAvatar.vue", "utf8");
    expect(avatar).toMatch(/resetAvatarState\(\);\s*showCachedAvatar\(\);/);
    expect(avatar).toContain("imageLoaded.value = true;");
    expect(avatar).toContain("rememberAvatarObjectUrl(account, avatar, blob)");
    expect(avatar).not.toContain("URL.revokeObjectURL");
  });

  it("keeps Calls alive like Conversations and acknowledges the badge on every visit", () => {
    const app = readFileSync("src/App.vue", "utf8");
    expect(app).toMatch(/:include="\[[^\]]*'Calls'[^\]]*\]"/);
    const calls = readFileSync("src/views/Calls.vue", "utf8");
    expect(calls).toMatch(/onActivated\(\(\) => \{[\s\S]*?acknowledgeCalls\(\);/);
    expect(calls).toMatch(/onDeactivated\(\(\) => \{[\s\S]*?showPicker\.value = false;/);
  });
});
