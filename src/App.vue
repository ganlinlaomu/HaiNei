<template>
  <div class="app-root" :class="{ 'login-route': hideAppChrome, 'compose-fab-page': isPrimaryRoute }">
    <UpdateNotification />
    <HeaderBar v-if="!hideAppChrome" />
    <router-view v-slot="{ Component }">
      <keep-alive :include="['Home', 'Friends', 'Conversations', 'Notifications', 'Settings']">
        <component :is="Component" />
      </keep-alive>
    </router-view>
    <button
      v-if="showComposeFab"
      class="compose-fab"
      type="button"
      :aria-label="fabLabel"
      @pointerdown="handleFabIntent"
      @focus="handleFabIntent"
      @click="handleFabClick"
    >
      <span class="fab-icon-stage" aria-hidden="true">
        <Transition :name="isConversationsRoute ? 'fab-to-message' : 'fab-to-compose'">
          <svg v-if="isConversationsRoute" key="message" class="fab-message-icon" viewBox="0 0 24 24">
            <path d="M20 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4v3" />
            <path d="M18 2v6M15 5h6" />
          </svg>
          <span v-else key="compose" class="fab-plus">+</span>
        </Transition>
      </span>
    </button>
    <ToastContainer />
    <PostEditorModal v-if="!hideAppChrome && postEditorReady" />
    <div
      v-if="!hideAppChrome && ui.showPostEditor && !postEditorReady"
      class="composer-loading-overlay"
      role="status"
      aria-live="polite"
      @click.self="ui.closePostEditor()"
    >
      <div class="composer-loading-card" :role="postEditorLoadError ? 'alert' : undefined">
        <template v-if="postEditorLoadError">
          <span>发帖页面加载失败</span>
          <button type="button" class="composer-retry-button" @click="preparePostEditor">重试</button>
        </template>
        <template v-else>
          <span class="composer-loading-spinner" aria-hidden="true"></span>
          <span>正在打开发帖页面…</span>
        </template>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { computed, defineAsyncComponent, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import HeaderBar from "@/components/HeaderBar.vue";
import ToastContainer from "@/components/ToastContainer.vue";
import UpdateNotification from "@/components/UpdateNotification.vue";
import { useUIStore } from "@/stores/ui";
import { loadPostEditor, preloadPostEditor } from "@/components/postEditorLoader";
import { useKeyStore } from "@/stores/keys";
import { warmReadRelaysForSession } from "@/nostr/relayWarmup";
import { preloadBottomTabViews } from "@/router/lazyViews";

const PostEditorModal = defineAsyncComponent(loadPostEditor);

export default defineComponent({
  components: { HeaderBar, ToastContainer, PostEditorModal, UpdateNotification },
  setup() {
    const route = useRoute();
    const ui = useUIStore();
    const keys = useKeyStore();
    const postEditorReady = ref(false);
    const postEditorLoadError = ref(false);
    const hideAppChrome = computed(() => route.meta.hideHeader === true);
    const primaryRoutes = new Set(["Home", "Friends", "Conversations", "Notifications", "Settings", "MyProfile", "Saved", "Profile"]);
    const isPrimaryRoute = computed(() => !hideAppChrome.value && primaryRoutes.has(String(route.name || "")));
    const isConversationsRoute = computed(() => route.name === "Conversations");
    const fabLabel = computed(() => isConversationsRoute.value ? "开始新私信" : "发帖");
    const showComposeFab = computed(() => !hideAppChrome.value
      && isPrimaryRoute.value
      && !ui.showPostEditor
      && !ui.showNewConversation
      && ui.blockingOverlays.size === 0);
    let disposed = false;
    let idleHandle: number | null = null;
    let bottomTabIdleHandle: number | null = null;
    let bottomTabsPreloaded = false;

    async function preparePostEditor() {
      postEditorLoadError.value = false;
      try {
        await loadPostEditor();
        if (!disposed) postEditorReady.value = true;
      } catch {
        if (!disposed) postEditorLoadError.value = true;
      }
    }

    function schedulePostEditorWarmup() {
      if (hideAppChrome.value || postEditorReady.value || idleHandle !== null) return;
      const requestIdle = (window as any).requestIdleCallback as undefined | ((callback: () => void, options?: { timeout: number }) => number);
      if (requestIdle) {
        idleHandle = requestIdle(() => {
          idleHandle = null;
          void preparePostEditor();
        }, { timeout: 1_500 });
      } else {
        idleHandle = window.setTimeout(() => {
          idleHandle = null;
          void preparePostEditor();
        }, 1_200);
      }
    }

    function scheduleBottomTabWarmup() {
      if (bottomTabsPreloaded || bottomTabIdleHandle !== null || !keys.isLoggedIn || !keys.isUnlocked) return;
      const warmup = () => {
        bottomTabIdleHandle = null;
        bottomTabsPreloaded = true;
        void preloadBottomTabViews();
      };
      const requestIdle = (window as any).requestIdleCallback as undefined | ((callback: () => void, options?: { timeout: number }) => number);
      if (requestIdle) bottomTabIdleHandle = requestIdle(warmup, { timeout: 2_000 });
      else bottomTabIdleHandle = window.setTimeout(warmup, 800);
    }

    function handleFabIntent() {
      if (!isConversationsRoute.value) preloadPostEditor();
    }

    function handleFabClick() {
      if (isConversationsRoute.value) ui.openNewConversation();
      else ui.openPostEditor();
    }

    watch(
      hideAppChrome,
      (hidden) => {
        document.body.classList.toggle("login-page", hidden);
        if (!hidden) schedulePostEditorWarmup();
      },
      { immediate: true }
    );
    watch(() => ui.showPostEditor, show => {
      document.body.classList.toggle("post-editor-open", show);
      if (show && !postEditorReady.value) void preparePostEditor();
    });
    watch(() => route.name, name => {
      if (name !== "Conversations") ui.closeNewConversation();
    });
    watch(
      () => [keys.isLoggedIn, keys.isUnlocked] as const,
      ([isLoggedIn, isUnlocked]) => {
        warmReadRelaysForSession({ isLoggedIn, isUnlocked });
        if (isLoggedIn && isUnlocked) scheduleBottomTabWarmup();
      },
      { immediate: true }
    );
    onMounted(schedulePostEditorWarmup);
    onBeforeUnmount(() => {
      disposed = true;
      if (idleHandle !== null) {
        const cancelIdle = (window as any).cancelIdleCallback as undefined | ((handle: number) => void);
        if (cancelIdle) cancelIdle(idleHandle);
        else window.clearTimeout(idleHandle);
      }
      if (bottomTabIdleHandle !== null) {
        const cancelIdle = (window as any).cancelIdleCallback as undefined | ((handle: number) => void);
        if (cancelIdle) cancelIdle(bottomTabIdleHandle);
        else window.clearTimeout(bottomTabIdleHandle);
      }
      document.body.classList.remove("login-page", "post-editor-open");
    });
    return {
      ui,
      hideAppChrome,
      isPrimaryRoute,
      isConversationsRoute,
      fabLabel,
      showComposeFab,
      postEditorReady,
      postEditorLoadError,
      preparePostEditor,
      handleFabIntent,
      handleFabClick,
    };
  }
});
</script>

<style>
body.login-page {
  padding-bottom: 0;
  background: #0b1017;
}

body.login-page > #app {
  max-width: none;
  padding: 0;
}

body.post-editor-open > #app {
  overflow: hidden;
}

.app-root.compose-fab-page {
  padding-bottom: 72px;
}

.composer-loading-overlay {
  position: fixed;
  inset: 0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom)) 0;
  z-index: 2000;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 23, 42, 0.38);
}

.compose-fab {
  position: fixed;
  display: grid;
  place-items: center;
  right: max(18px, env(safe-area-inset-right));
  bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 18px);
  z-index: 1200;
  width: 54px;
  height: 54px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: #1687e8;
  box-shadow: 0 7px 20px rgba(22, 135, 232, 0.32);
  color: #fff;
  font-size: 34px;
  font-weight: 300;
  line-height: 1;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.compose-fab:active { transform: scale(.96); }

.fab-icon-stage {
  display: grid;
  width: 30px;
  height: 30px;
  margin: auto;
  place-items: center;
}

.fab-icon-stage > * { grid-area: 1 / 1; }
.fab-plus { display: block; font-size: 34px; font-weight: 300; line-height: 28px; }
.fab-message-icon { width: 27px; height: 27px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.fab-to-message-enter-active,
.fab-to-message-leave-active,
.fab-to-compose-enter-active,
.fab-to-compose-leave-active {
  transform-origin: center;
  transition: opacity 240ms cubic-bezier(.2,.75,.25,1), transform 240ms cubic-bezier(.2,.75,.25,1);
}
.fab-to-message-enter-from { opacity: 0; transform: scale(.72) rotate(90deg); }
.fab-to-message-leave-to { opacity: 0; transform: scale(.72) rotate(-90deg); }
.fab-to-compose-enter-from { opacity: 0; transform: scale(.72) rotate(-90deg); }
.fab-to-compose-leave-to { opacity: 0; transform: scale(.72) rotate(90deg); }

.composer-loading-card {
  width: min(100%, 720px);
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border-radius: 14px;
  background: #fff;
  color: #475569;
  font-size: 14px;
}

.composer-loading-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid #cbd5e1;
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: composer-spin 650ms linear infinite;
}

.composer-retry-button {
  min-height: 40px;
  padding: 0 16px;
  border: 1px solid #3b82f6;
  border-radius: 10px;
  background: #3b82f6;
  color: #fff;
  font: inherit;
  cursor: pointer;
}

@keyframes composer-spin {
  to { transform: rotate(360deg); }
}

@media (min-width: 768px) {
  .composer-loading-overlay {
    inset: 0;
    align-items: center;
  }

  .compose-fab {
    right: max(28px, calc((100vw - var(--navigation-rail-width) - var(--main-content-max-width)) / 2 + 28px));
    bottom: 28px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fab-to-message-enter-active,
  .fab-to-message-leave-active,
  .fab-to-compose-enter-active,
  .fab-to-compose-leave-active { transition: none; }
  .fab-to-message-enter-from,
  .fab-to-message-leave-to,
  .fab-to-compose-enter-from,
  .fab-to-compose-leave-to { opacity: 1; transform: none; }
}
</style>
