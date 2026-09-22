import { describe, expect, it, vi } from "vitest";
import { canViewPrivateProfile, openProfile, profileLocation } from "@/utils/profileNavigation";

const ACCOUNT = "a".repeat(64);
const FRIEND = "b".repeat(64);
const STRANGER = "c".repeat(64);

describe("private profile navigation", () => {
  it("opens the editor for the current account", () => {
    expect(profileLocation(ACCOUNT, ACCOUNT)).toBe("/settings/profile");
  });

  it("opens the read-only profile route for an accepted friend", () => {
    const push = vi.fn();
    openProfile({ push } as any, ACCOUNT, FRIEND);
    expect(push).toHaveBeenCalledWith(`/profile/${FRIEND}`);
    expect(canViewPrivateProfile(ACCOUNT, FRIEND, pubkey => pubkey === FRIEND)).toBe(true);
  });

  it("does not authorize a non-friend's cached private profile", () => {
    expect(canViewPrivateProfile(ACCOUNT, STRANGER, () => false)).toBe(false);
  });

  it("stops a nested notification avatar click before opening the profile", () => {
    let propagationStopped = false;
    let rowNavigationTriggered = false;
    const event = {
      stopPropagation: vi.fn(() => { propagationStopped = true; })
    };
    const push = vi.fn();
    openProfile({ push } as any, ACCOUNT, FRIEND, event as any);
    if (!propagationStopped) rowNavigationTriggered = true;
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(rowNavigationTriggered).toBe(false);
    expect(push).toHaveBeenCalledWith(`/profile/${FRIEND}`);
  });
});
