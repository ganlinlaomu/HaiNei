import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBottomNavTabIndex } from "@/utils/bottomNavigation";

describe("liquid bottom navigation", () => {
  it("tracks the five tabs and keeps settings subpages selected", () => {
    expect(getBottomNavTabIndex("/")).toBe(0);
    expect(getBottomNavTabIndex("/conversations")).toBe(1);
    expect(getBottomNavTabIndex("/calls")).toBe(2);
    expect(getBottomNavTabIndex("/friends")).toBe(3);
    expect(getBottomNavTabIndex("/settings")).toBe(4);
    expect(getBottomNavTabIndex("/settings/system")).toBe(4);
    expect(getBottomNavTabIndex("/settings/profile")).toBe(4);
    expect(getBottomNavTabIndex("/settings/saved")).toBe(4);
  });

  it("does not suggest a selected tab on conversation, profile, or login routes", () => {
    for (const path of ["/messages/abc", "/profile/abc", "/notifications", "/debug", "/login"]) {
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
    expect(source).toContain('v-if="directMessages.unreadCount + nearbyUnread.count > 0"');
    expect(source).toContain('to="/calls"');
    expect(source).toContain('to="/friends"');
    expect(source).toContain('class="nav-label"');
    expect(source).toContain('name.startsWith("comment-sheet-")');
    expect(source).toContain("route.meta.hideBottomNav === true");
    expect(source).toContain("@click=\"handleNavigation\"");
    expect(source).toContain("@pointerdown=\"preloadBottomTab('conversations')\"");
    expect(source).toContain("@pointerdown=\"preloadBottomTab('calls')\"");
    expect(source).toContain("@pointerdown=\"preloadBottomTab('friends')\"");
    expect(source).toContain("@pointerdown=\"preloadBottomTab('settings')\"");
    expect(source).toContain("@media (min-width: 768px)");
    expect(source).toContain(".nav-liquid-track {");
    expect(source).toContain("display: none;");
    expect(source).toContain("bottom: calc(12px + env(safe-area-inset-bottom));");
    expect(source).toContain("left: max(16px, env(safe-area-inset-left));");
    expect(source).toContain("right: max(16px, env(safe-area-inset-right));");
    expect(source).toContain("border-radius: 22px;");
    expect(source).toContain("inset: 6px 8px;");
    expect(source).toMatch(/@media \\(min-width: 768px\\)[\\s\\S]*?\\.bottom-nav \\{[\\s\\S]*?left: 0;/);
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
    expect(source).toContain("pointer-events: none;");
  });
});
