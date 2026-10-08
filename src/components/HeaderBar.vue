<template>

  <!-- Keep existing navigation controls; the mobile glass bubble is decorative only. -->
  <nav v-if="shouldShowBottomNav" class="bottom-nav" aria-label="主导航">
    <div v-if="activeTabIndex >= 0" class="nav-liquid-track" aria-hidden="true">
      <span class="nav-liquid-indicator" :style="{ '--nav-slide': `${activeTabIndex * 100}%` }">
        <span :key="activeTabIndex" class="nav-liquid-surface"></span>
      </span>
    </div>
    <router-link class="nav-item" :class="{ 'is-current-tab': activeTabIndex === 0 }" to="/" aria-label="首页" @click="handleNavigation">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
        <polyline points="9 22 9 12 15 12 15 22"></polyline>
      </svg>
    </router-link>
    <router-link class="nav-item" :class="{ 'is-current-tab': activeTabIndex === 1 }" to="/conversations" aria-label="私信" @pointerdown="preloadBottomTab('conversations')" @focus="preloadBottomTab('conversations')" @click="handleNavigation">
      <span class="icon-wrapper">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>
        </svg>
        <span v-if="directMessages.unreadCount > 0" class="badge">{{ directMessages.unreadCount }}</span>
      </span>
    </router-link>
    <router-link class="nav-item" :class="{ 'is-current-tab': activeTabIndex === 2 }" to="/notifications" aria-label="通知" @pointerdown="preloadBottomTab('notifications')" @focus="preloadBottomTab('notifications')" @click="handleNavigation">
      <span class="icon-wrapper">
        <svg
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>

        <!-- 🔴 小红点 / 数字 -->
        <span
          v-if="notifications.unreadCount > 0"
          class="badge"
        >
          {{ notifications.unreadCount }}
        </span>
      </span>
    </router-link>
    <router-link class="nav-item" :class="{ 'is-current-tab': activeTabIndex === 3 }" to="/settings" aria-label="我的" @pointerdown="preloadBottomTab('settings')" @focus="preloadBottomTab('settings')" @click="handleNavigation">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="8" r="4"></circle>
        <path d="M4 21a8 8 0 0 1 16 0"></path>
      </svg>
    </router-link>
  </nav>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";
import { useRoute } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { useNotificationsStore } from "@/stores/notifications";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { loadConversationsView, loadNotificationsView, loadSettingsView } from "@/router/lazyViews";
import { getBottomNavTabIndex } from "@/utils/bottomNavigation";


export default defineComponent({
  name: "Headbar",
  setup() {
    const keys = useKeyStore();
    const ui = useUIStore();
    const notifications = useNotificationsStore();
    const directMessages = useDirectMessagesStore();
    const route = useRoute();
    const activeTabIndex = computed(() => getBottomNavTabIndex(route.path));
    const isLoggedIn = computed(() => !!keys.pkHex);
    const shortPk = computed(() => (keys.pkHex ? keys.pkHex.slice(0, 8) + "..." : ""));
    
    // Hide bottom nav when user needs to unlock (encrypted but not unlocked)
    const shouldShowBottomNav = computed(() => {
      if (!keys.pkHex) return false; // Not logged in at all
      if (keys.isEncrypted && !keys.isUnlocked) return false; // Needs to unlock
      if (route.meta.hideBottomNav === true) return false;
      if ([...ui.blockingOverlays].some(name => name.startsWith("comment-sheet-"))) return false;
      return true; // Logged in and unlocked (or not encrypted)
    });

    type BottomTab = "conversations" | "notifications" | "settings";

    function preloadBottomTab(tab: BottomTab) {
      const loader = tab === "conversations"
        ? loadConversationsView
        : tab === "notifications"
          ? loadNotificationsView
          : loadSettingsView;
      void loader().catch(() => undefined);
    }

    function handleNavigation() {
      ui.closePostEditor();
    }
    
    return { isLoggedIn, shortPk, preloadBottomTab, handleNavigation, notifications, directMessages, shouldShowBottomNav, activeTabIndex, ui };
  }
});
</script>

<style scoped>
.headbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  background: #fff;
  border-bottom: 1px solid rgba(0,0,0,0.06);
}
.brand { font-weight: 700; text-decoration: none; color: inherit; }
.login-link { text-decoration: none; color: #1976d2; }

/* =========================
   Bottom Navigation (iOS / PWA Optimized)
   ========================= */

.bottom-nav {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;

  /* 尺寸 */
  height: 80px;
  padding-top: 12px;
  padding-bottom: calc(12px + env(safe-area-inset-bottom));

  /* 布局 */
  display: flex;
  justify-content: space-around;
  align-items: center;

  /* 视觉（替代 backdrop-filter，性能友好） */
  background: rgba(255, 255, 255, 0.94);
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 -1px 8px rgba(0, 0, 0, 0.06);

  /* 层级 */
  z-index: var(--z-bottom-nav, 9999);
  isolation: isolate;

  /* 防止 iOS 路由切换抖动 */
  will-change: transform;
  transform: translateZ(0);
  -webkit-transform: translateZ(0);

  /* 确保可交互 */
  pointer-events: auto;
}

/* Single mobile-only selector; track follows the nav content box and safe area. */
.nav-liquid-track {
  position: absolute;
  inset: 12px 0 calc(12px + env(safe-area-inset-bottom));
  display: flex;
  align-items: center;
  z-index: 0;
  pointer-events: none;
}

.nav-liquid-indicator {
  position: relative;
  flex: 0 0 25%;
  height: 48px;
  transform: translate3d(var(--nav-slide, 0%), 0, 0);
  transition: transform 440ms cubic-bezier(.22, 1.13, .32, 1);
  will-change: transform;
  pointer-events: none;
}

.nav-liquid-surface {
  position: absolute;
  inset: 1px 5px;
  border-radius: 999px;
  background: linear-gradient(150deg,
    rgba(255, 255, 255, .89),
    rgba(213, 222, 233, .64) 52%,
    rgba(227, 234, 242, .76));
  border: 1px solid rgba(255, 255, 255, .96);
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, .95),
    inset 0 -2px 3px rgba(92, 114, 139, .11),
    0 2px 9px rgba(49, 64, 83, .11);
  -webkit-backdrop-filter: blur(6px) saturate(1.15);
  backdrop-filter: blur(6px) saturate(1.15);
  animation: nav-liquid-settle 440ms cubic-bezier(.2, .8, .28, 1) both;
}

.nav-liquid-surface::after {
  content: "";
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  border-top: 1px solid rgba(255, 255, 255, .9);
  pointer-events: none;
}

@keyframes nav-liquid-settle {
  0%, 100% { transform: scaleX(1) scaleY(1); }
  48% { transform: scaleX(1.16) scaleY(.94); }
  78% { transform: scaleX(.97) scaleY(1.02); }
}

/* =========================
   Nav Item
   ========================= */

.nav-item {
  flex: 1;
  min-width: 0;
  min-height: 48px;
  padding: 4px;

  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  text-decoration: none;
  color: #64748b;
  cursor: pointer;
  border-radius: 12px;
  position: relative;
  z-index: 1;

  /* ❗ 不用 transition: all */
  transition:
    color 0.22s ease,
    background-color 0.22s ease,
    transform 0.22s ease;
}

.nav-item:active {
  background: rgba(59, 130, 246, 0.08);
  color: #3b82f6;
  transform: scale(.97);
}

/* Only real hover-capable pointers get hover styling. On iOS PWA a tap can
   otherwise leave :hover stuck while the route chunk is still resolving. */
@media (hover: hover) and (pointer: fine) {
  .nav-item:hover {
    background: rgba(59, 130, 246, 0.08);
    color: #3b82f6;
    transform: translateY(-2px);
  }
}

/* 路由激活 */
.nav-item.router-link-active,
.nav-item.is-current-tab {
  color: #1976d2;
}

/* =========================
   Icon
   ========================= */

.icon {
  width: 24px;
  height: 24px;
  stroke: currentColor;

  /* 只允许 transform 参与动画，避免 SVG repaint */
  transition: transform 0.22s ease;
}

/* 激活态轻微强调（不改 stroke-width，避免重绘） */
.nav-item.router-link-active .icon,
.nav-item.is-current-tab .icon {
  transform: scale(1.08);
}

/* =========================
   Notification Badge
   ========================= */

.icon-wrapper {
  position: relative;
  display: inline-flex;
}

.badge {
  position: absolute;
  top: -4px;
  right: -6px;

  min-width: 16px;
  height: 16px;
  padding: 0 4px;

  background: #ef4444;
  color: white;

  font-size: 10px;
  font-weight: 600;
  line-height: 1;

  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;

  /* 防止 badge 变化影响主层合成 */
  will-change: contents;
}

/* The bubble owns the selection background on touch devices. */
@media (max-width: 767px) {
  .nav-item:active { background: transparent; }
}

.nav-item:focus-visible {
  outline: 2px solid #1976d2;
  outline-offset: -3px;
}

@media (prefers-reduced-motion: reduce) {
  .nav-liquid-indicator,
  .nav-liquid-surface {
    transition: none;
    animation: none;
  }
}

/* =========================
   iOS 特殊优化
   ========================= */

/* 禁用 iOS 点击高亮 */
.bottom-nav,
.nav-item {
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}

/* iOS Safari 滚动稳定性 */
@supports (-webkit-touch-callout: none) {
  .bottom-nav {
    transform: translateZ(0);
  }
}

@media (min-width: 768px) {
  .nav-liquid-track { display: none; }

  .bottom-nav {
    top: 0;
    right: auto;
    bottom: 0;
    width: var(--navigation-rail-width);
    height: 100dvh;
    padding: 18px 10px;
    flex-direction: column;
    justify-content: center;
    gap: 12px;
    border-top: 0;
    border-right: 1px solid rgba(0, 0, 0, 0.08);
    box-shadow: 1px 0 8px rgba(0, 0, 0, 0.05);
    transform: none;
    -webkit-transform: none;
  }

  .nav-item {
    width: 100%;
    min-height: 52px;
    flex: 0 0 52px;
    padding: 10px;
  }

}

@media (min-width: 768px) and (hover: hover) and (pointer: fine) {
  .nav-item:hover {
    transform: translateX(2px);
  }
}

@media (min-width: 1200px) {
  .bottom-nav {
    padding-right: 14px;
    padding-left: 14px;
  }

  .nav-item {
    min-height: 56px;
    flex-basis: 56px;
  }
}

</style>
