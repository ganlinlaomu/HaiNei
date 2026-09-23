<template>

  <!-- bottom nav moved into Headbar file for simplicity; only shown when logged in and unlocked -->
  <nav v-if="shouldShowBottomNav" class="bottom-nav">
    <router-link class="nav-item" to="/" @click="handleNavigation">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
        <polyline points="9 22 9 12 15 12 15 22"></polyline>
      </svg>
      <span class="nav-label">首页</span>
    </router-link>
    <router-link class="nav-item" to="/friends" @click="handleNavigation">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
        <circle cx="9" cy="7" r="4"></circle>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
      </svg>
      <span class="nav-label">好友</span>
    </router-link>
    <router-link class="nav-item" to="/conversations" @click="handleNavigation">
      <span class="icon-wrapper">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>
        </svg>
        <span v-if="directMessages.unreadCount > 0" class="badge">{{ directMessages.unreadCount }}</span>
      </span>
      <span class="nav-label">私信</span>
    </router-link>
    <router-link class="nav-item" to="/notifications" @click="handleNavigation">
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

      <span class="nav-label">通知</span>
    </router-link>
    <router-link class="nav-item" to="/settings" @click="handleNavigation">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="8" r="4"></circle>
        <path d="M4 21a8 8 0 0 1 16 0"></path>
      </svg>
      <span class="nav-label">我的</span>
    </router-link>
  </nav>
</template>

<script lang="ts">
import { defineComponent, computed, watch } from "vue";
import { useRoute } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { useNotificationsStore } from "@/stores/notifications";
import { accountBadgeCount, syncAppBadge } from "@/utils/appBadge";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { useMessagesStore } from "@/stores/messages";


export default defineComponent({
  name: "Headbar",
  setup() {
    const keys = useKeyStore();
    const ui = useUIStore();
    const notifications = useNotificationsStore();
    const directMessages = useDirectMessagesStore();
    const messages = useMessagesStore();
    const route = useRoute();
    const isLoggedIn = computed(() => !!keys.pkHex);
    const shortPk = computed(() => (keys.pkHex ? keys.pkHex.slice(0, 8) + "..." : ""));
    
    // Hide bottom nav when user needs to unlock (encrypted but not unlocked)
    const shouldShowBottomNav = computed(() => {
      if (!keys.pkHex) return false; // Not logged in at all
      if (keys.isEncrypted && !keys.isUnlocked) return false; // Needs to unlock
      if (route.meta.hideBottomNav === true) return false;
      return true; // Logged in and unlocked (or not encrypted)
    });

    watch(
      () => [keys.pkHex, notifications.loadedFor, notifications.unreadCount, directMessages.loadedFor, directMessages.unreadCount] as const,
      ([account, loadedFor, unreadCount, directLoadedFor, directUnread]) => {
        void syncAppBadge(accountBadgeCount(account, loadedFor, unreadCount, directLoadedFor, directUnread)).catch(() => undefined);
      },
      { immediate: true }
    );

    watch(() => `${keys.pkHex}:${messages.inbox.length}:${messages.inbox[0]?.id || ""}`, () => {
      void directMessages.refresh(keys.pkHex);
    });

    function handleNavigation() {
      ui.closePostEditor();
    }
    
    return { isLoggedIn, shortPk, handleNavigation, notifications, directMessages, shouldShowBottomNav, ui };
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
  align-items: flex-start;

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

/* =========================
   Nav Item
   ========================= */

.nav-item {
  flex: 1;
  min-width: 0;
  padding: 8px 4px;

  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;

  text-decoration: none;
  color: #64748b;
  cursor: pointer;
  border-radius: 12px;
  position: relative;

  /* ❗ 不用 transition: all */
  transition:
    color 0.22s ease,
    background-color 0.22s ease,
    transform 0.22s ease;
}

/* hover / active（桌面 & Android） */
.nav-item:hover {
  background: rgba(59, 130, 246, 0.08);
  color: #3b82f6;
  transform: translateY(-2px);
}

/* 路由激活 */
.nav-item.router-link-active {
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
.nav-item.router-link-active .icon {
  transform: scale(1.08);
}

/* =========================
   Label
   ========================= */

.nav-label {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
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

/* =========================
   iOS 特殊优化
   ========================= */

/* 禁用 iOS 点击高亮 */
.bottom-nav,
.nav-item {
  -webkit-tap-highlight-color: transparent;
}

/* iOS Safari 滚动稳定性 */
@supports (-webkit-touch-callout: none) {
  .bottom-nav {
    transform: translateZ(0);
  }
}

</style>
