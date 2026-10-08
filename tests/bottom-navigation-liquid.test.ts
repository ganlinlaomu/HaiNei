import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBottomNavTabIndex } from "@/utils/bottomNavigation";

describe("liquid bottom navigation", () => {
  it("tracks the four tabs and keeps settings subpages selected", () => {
    expect(getBottomNavTabIndex("/")).toBe(0);
    expect(getBottomNavTabIndex("/conversations")).toBe(1);
    expect(getBottomNavTabIndex("/notifications")).toBe(2);
    expect(getBottomNavTabIndex("/settings")).toBe(3);
    expect(getBottomNavTabIndex("/settings/system")).toBe(3);
    expect(getBottomNavTabIndex("/settings/profile")).toBe(3);
    expect(getBottomNavTabIndex("/settings/saved")).toBe(3);
  });

  it("does not suggest a selected tab on conversation, profile, or login routes", () => {
    for (const path of ["/messages/abc", "/profile/abc", "/friends", "/debug", "/login"]) {
      expect(getBottomNavTabIndex(path)).toBe(-1);
    }
  });

  it("keeps navigation, unread badges, overlay guards and mobile-only animation", () => {
    const source = readFileSync("src/components/HeaderBar.vue", "utf8");
    expect(source).toContain('class="nav-liquid-track"');
    expect(source).toContain('class="nav-liquid-indicator"');
    expect(source).toContain('class="nav-liquid-surface"');
    expect(source).toContain('aria-hidden="true"');
    expect(source).toContain("getBottomNavTabIndex(route.path)");
    expect(source).toContain('v-if="directMessages.unreadCount > 0"');
    expect(source).toContain('v-if="notifications.unreadCount > 0"');
    expect(source).toContain('name.startsWith("comment-sheet-")');
    expect(source).toContain("route.meta.hideBottomNav === true");
    expect(source).toContain("@click=\"handleNavigation\"");
    expect(source).toContain("@pointerdown=\"preloadBottomTab('conversations')\"");
    expect(source).toContain("@pointerdown=\"preloadBottomTab('notifications')\"");
    expect(source).toContain("@pointerdown=\"preloadBottomTab('settings')\"");
    expect(source).toContain("@media (min-width: 768px)");
    expect(source).toContain(".nav-liquid-track {");
    expect(source).toContain("display: none;");
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
    expect(source).toContain("pointer-events: none;");
  });
});
