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

  /* Frosted tint without blurring the whole scrolling viewport. */
  background: linear-gradient(180deg,
    rgba(251, 253, 255, .86),
    rgba(246, 249, 253, .94));
  border-top: 1px solid rgba(255, 255, 255, .9);
  box-shadow:
    0 -1px 0 rgba(66, 88, 113, .08),
    0 -6px 16px rgba(28, 48, 74, .05);

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

/* A single small blurred capsule: static highlights mimic liquid refraction
   without WebGPU, full-bar blur or continuous repainting animations. */
.nav-liquid-surface {
  position: absolute;
  inset: 1px 5px;
  border-radius: 999px;
  background:
    radial-gradient(ellipse 90% 95% at 18% 3%,
      rgba(255, 255, 255, .92), rgba(255, 255, 255, 0) 72%),
    linear-gradient(140deg,
      rgba(241, 250, 255, .84) 0%,
      rgba(207, 226, 242, .68) 49%,
      rgba(234, 244, 253, .8) 100%);
  border: 1px solid rgba(255, 255, 255, .92);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, .98),
    inset 0 -2px 3px rgba(63, 96, 136, .16),
    0 3px 10px rgba(41, 64, 91, .14);
  -webkit-backdrop-filter: blur(4px) saturate(1.18);
  backdrop-filter: blur(4px) saturate(1.18);
  animation: nav-liquid-settle 440ms cubic-bezier(.2, .8, .28, 1) both;
}

/* Curved specular glint is static; no pointer tracking or extra animation. */
.nav-liquid-surface::before,
.nav-liquid-surface::after {
  content: "";
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  pointer-events: none;
}

.nav-liquid-surface::before {
  background:
    radial-gradient(ellipse 67% 44% at 32% 3%,
      rgba(255, 255, 255, .8), transparent 95%),
    linear-gradient(104deg,
      rgba(255, 255, 255, .36), transparent 37%,
      rgba(68, 110, 150, .09) 87%, rgba(255, 255, 255, .26));
}

.nav-liquid-surface::after {
  border-top: 1px solid rgba(255, 255, 255, .96);
  border-left: 1px solid rgba(255, 255, 255, .66);
  border-right: 1px solid rgba(88, 127, 166, .16);
  border-bottom: 1px solid rgba(90, 124, 158, .17);
}

@keyframes nav-liquid-settle {
  0%, 100% { transform: scaleX(1) scaleY(1); }
  48% { transform: scaleX(1.13) scaleY(.95); }
  78% { transform: scaleX(.98) scaleY(1.02); }
}

/* Preserve a clear selected state when transparency is disabled or unavailable. */
@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
  .nav-liquid-surface {
    background: linear-gradient(145deg, #f7fcff, #d8e9f8);
  }
}

@media (prefers-reduced-transparency: reduce) {
  .bottom-nav { background: #fff; }
  .nav-liquid-surface {
    background: #e5f1fc;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

@media (forced-colors: active) {
  .nav-liquid-surface {
    background: Highlight;
    border: 1px solid Highlight;
    box-shadow: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .nav-liquid-surface::before,
  .nav-liquid-surface::after { display: none; }
  .nav-item.is-current-tab { color: HighlightText; }
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
    background: #fff;
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
