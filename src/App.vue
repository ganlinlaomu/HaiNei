<template>
  <div class="app-root" :class="{ 'login-route': hideAppChrome, 'compose-fab-page': isPrimaryRoute }">
    <UpdateNotification />
    <AndroidUpdateNotification />
    <CallNotificationRecovery />
    <CallOverlay v-if="call.phase !== 'idle'" />
    <HeaderBar v-if="!hideAppChrome" />
    <router-view v-slot="{ Component }">
      <keep-alive :key="`${keys.pkHex}:${keys.sessionGeneration}:${keys.isUnlocked}`" :include="['Home', 'Friends', 'Conversations', 'Notifications', 'Settings', 'SystemSettings']">
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
          <button type="button" class="composer-retry-button" @click="retryPostEditor">重试</button>
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
import { useRoute, useRouter } from "vue-router";
import CallNotificationRecovery from "@/components/CallNotificationRecovery.vue";
import HeaderBar from "@/components/HeaderBar.vue";
import ToastContainer from "@/components/ToastContainer.vue";
import UpdateNotification from "@/components/UpdateNotification.vue";
import AndroidUpdateNotification from "@/components/AndroidUpdateNotification.vue";
import { useUIStore } from "@/stores/ui";
import { loadPostEditor, preloadPostEditor } from "@/components/postEditorLoader";
import { isChunkLoadError, reloadForStaleChunk } from "@/utils/chunkLoadRecovery";
import { requestPersistentStorage } from "@/services/persistentStorage";
import { useKeyStore } from "@/stores/keys";
import { warmReadRelaysForSession } from "@/nostr/relayWarmup";
import { preloadBottomTabViews } from "@/router/lazyViews";
import { useNotificationsStore } from "@/stores/notifications";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { useCallStore } from "@/stores/call";
import { installPushPresence } from "@/services/pushPresence";
import { accountBadgeCount, syncAppBadge, syncAppBadgeScope } from "@/utils/appBadge";
import { installBackgroundLock } from "@/services/autoLock";
import { reconcileForegroundFriendState } from "@/services/foregroundFriendStateSync";
import { reconcileBookmarkCloudState } from "@/services/bookmarkCloudSync";
import { useBookmarksStore } from "@/stores/bookmarks";
import { onAppResume } from "@/services/appResumeCoordinator";
import { cancelBackgroundTask, installForegroundActivityMonitor, scheduleBackgroundTask } from "@/services/backgroundWorkScheduler";

const PostEditorModal = defineAsyncComponent(loadPostEditor);
// Kept in a separate chunk and loaded when a call actually appears.
const loadCallOverlay = () => import("@/components/CallOverlay.vue");
const CallOverlay = defineAsyncComponent(loadCallOverlay);

export default defineComponent({
  components: { CallNotificationRecovery, HeaderBar, ToastContainer, PostEditorModal, UpdateNotification, AndroidUpdateNotification, CallOverlay },
  setup() {
    const route = useRoute();
    const router = useRouter();
    let stopAutoLock: (() => void) | undefined;
    let stopForegroundResume: (() => void) | undefined;
    let stopActivityMonitor: (() => void) | undefined;
    const ui = useUIStore();
    const keys = useKeyStore();
    const notifications = useNotificationsStore();
    const directMessages = useDirectMessagesStore();
    const call = useCallStore();
    let pushPresence: ReturnType<typeof installPushPresence> | null = null;
    watch(() => [keys.pkHex, keys.isUnlocked] as const, () => pushPresence?.refresh());
    const bookmarks = useBookmarksStore();
    const postEditorReady = ref(false);
    const postEditorLoadError = ref(false);
    const hideAppChrome = computed(() => route.meta.hideHeader === true);
    const primaryRoutes = new Set(["Home"]);
    const isPrimaryRoute = computed(() => !hideAppChrome.value && primaryRoutes.has(String(route.name || "")));
    const isConversationsRoute = computed(() => route.name === "Conversations");
    const fabLabel = computed(() => "发帖");
    const showComposeFab = computed(() => !hideAppChrome.value
      && isPrimaryRoute.value
      && !ui.showPostEditor
      && !ui.showNewConversation
      && ui.blockingOverlays.size === 0);
    let disposed = false;
    let bottomTabsPreloaded = false;

    let postEditorChunkStale = false;
    async function preparePostEditor() {
      postEditorLoadError.value = false;
      try {
        await loadPostEditor();
        if (!disposed) postEditorReady.value = true;
      } catch (error) {
        postEditorChunkStale = isChunkLoadError(error);
        if (!disposed) postEditorLoadError.value = true;
      }
    }

    function retryPostEditor() {
      // A chunk from a replaced deploy never loads again; only a reload helps.
      if (postEditorChunkStale && reloadForStaleChunk()) return;
      void preparePostEditor();
    }

    function schedulePostEditorWarmup() {
      if (hideAppChrome.value || postEditorReady.value) return;
      scheduleBackgroundTask("preload-post-editor", preparePostEditor, { priority: "idle", timeoutMs: 2_500 });
    }

    function scheduleBottomTabWarmup() {
      if (bottomTabsPreloaded || !keys.isLoggedIn || !keys.isUnlocked) return;
      scheduleBackgroundTask("preload-bottom-tabs", async () => {
        bottomTabsPreloaded = true;
        await preloadBottomTabViews();
      }, { priority: "idle", timeoutMs: 2_000 });
    }

    function handleFabIntent() {
      preloadPostEditor();
    }

    function handleFabClick() {
      ui.openPostEditor();
    }

    function reconcileFriendStateOnForeground() {
      if (document.visibilityState === "hidden" || !keys.isLoggedIn || !keys.isUnlocked) return;
      void reconcileForegroundFriendState(keys).catch(error => {
        console.warn("[account-state] foreground friend reconciliation failed", error instanceof Error ? error.message : "unknown");
      });
    }

    function reconcileBookmarksOnForeground(force = false) {
      if (document.visibilityState === "hidden" || !keys.isLoggedIn || !keys.isUnlocked) return;
      void reconcileBookmarkCloudState(keys, { force }).then(async result => {
        if (result.restored && keys.pkHex) await bookmarks.load(keys.pkHex, true);
      }).catch(error => {
        console.warn("[bookmarks] foreground cloud reconciliation failed", error instanceof Error ? error.message : "unknown");
      });
    }

    function prewarmRemoteSignerOnForeground() {
      if (document.visibilityState === "hidden" || keys.loginMethod !== "nip46" || !keys.isUnlocked) return;
      void keys.prewarmRemoteSigner().catch(error => {
        console.warn("[nip46] foreground reconnect unavailable", error instanceof Error ? error.message : "unknown");
      });
    }

    watch(
      () => [
        keys.pkHex,
        keys.isUnlocked,
        keys.isRestored,
        notifications.loadedFor,
        notifications.unreadCount,
        directMessages.loadedFor,
        directMessages.unreadCount,
        directMessages.readStateRestorePhase,
      ] as const,
      ([account, unlocked, restored, loadedFor, unreadCount, directLoadedFor, directUnread, directRestorePhase]) => {
        // Before session restoration finishes, an empty store is not a logout.
        // Keep the persisted push scope so a cold-start race cannot suppress it.
        if (!account && !restored) return;
        // Locking protects private data, but it must not erase the last known
        // numeric unread badge. Keep routing bound to the remembered account;
        // only an actual logout clears the count and scope.
        if (!account) {
          void syncAppBadge(0, undefined, "").catch(() => undefined);
          return;
        }
        // While DM unread is still restoring, the in-app count is masked and
        // is not authoritative. Keep the Push-provided badge (and its routing)
        // until the durable projection is ready instead of writing 0.
        if (!unlocked || directRestorePhase === "restoring") {
          void syncAppBadgeScope(account).catch(() => undefined);
          return;
        }
        void syncAppBadge(
          accountBadgeCount(account, loadedFor, unreadCount, directLoadedFor, directUnread), undefined, account,
        ).catch(() => undefined);
      },
      { immediate: true }
    );

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
        if (isLoggedIn && isUnlocked) {
          scheduleBottomTabWarmup();
          void requestPersistentStorage();
        }
      },
      { immediate: true }
    );
    const STARTUP_MESSAGES_WAIT_MS = 15_000;
    function waitForStartupMessages() {
      if (directMessages.historyHydrationPhase !== "hydrating") return Promise.resolve();
      return new Promise<void>(resolve => {
        const timer = window.setTimeout(done, STARTUP_MESSAGES_WAIT_MS);
        const stop = watch(() => directMessages.historyHydrationPhase, phase => { if (phase !== "hydrating") done(); });
        function done() { window.clearTimeout(timer); stop(); resolve(); }
      });
    }
    // 文件传输助手: join the own-devices room once per session, so this
    // device can receive (and be found) without opening the assistant first.
    watch(
      () => [keys.pkHex, keys.loginMethod, keys.skHex, keys.isUnlocked] as const,
      ([account, method, secret, unlocked]) => {
        if (!account || method !== "private-key" || !unlocked || !/^[0-9a-f]{64}$/.test(secret)) return;
        const current = () => keys.pkHex === account && keys.skHex === secret && keys.isUnlocked;
        scheduleBackgroundTask("nearby-own-devices", async () => {
          // Joining loads the transfer module and opens signaling; let the
          // startup message restore (until unread is shown) finish first.
          await waitForStartupMessages();
          if (!current()) return;
          const { ensureOwnDevicesRoom } = await import("@/services/nearbySession");
          if (current()) await ensureOwnDevicesRoom(account, secret);
        }, { priority: "idle", timeoutMs: 5_000 });
      },
      { immediate: true }
    );
    onMounted(() => {
      stopActivityMonitor = installForegroundActivityMonitor();
      pushPresence = installPushPresence(keys);
      stopAutoLock=installBackgroundLock({account:()=>keys.pkHex,eligible:()=>keys.isEncrypted && keys.isUnlocked && keys.credentialMode !== "device",lock:async()=>{ui.closePostEditor();ui.closeNewConversation();await keys.selectRememberedAccount(keys.pkHex);await router.replace("/login");}});
      schedulePostEditorWarmup();
      // Do not parse the WebRTC engine and call overlay during startup.
      // Incoming call signals load the engine on demand; the overlay
      // follows reactively when the call becomes visible.
      stopForegroundResume = onAppResume(reason => {
        // Friendship authorization stays urgent. Bookmark reconciliation can
        // wait for foreground idle time so NIP-17 catch-up wins on app resume.
        reconcileFriendStateOnForeground();
        const resumedAccount = keys.pkHex;
        scheduleBackgroundTask("foreground-bookmark-sync", () => {
          if (keys.pkHex === resumedAccount) reconcileBookmarksOnForeground(reason === "online");
        }, { priority: "idle", timeoutMs: 2_500 });
        if (keys.isLoggedIn && keys.isUnlocked) {
          void import("@/services/privateSpaceSync").then(({ schedulePrivateSpaceSync }) => {
            if (keys.isLoggedIn && keys.isUnlocked) schedulePrivateSpaceSync(keys, reason === "online" ? 0 : 3_000);
          }).catch(() => { /* Keep foreground navigation responsive if notes cannot sync. */ });
        }
        prewarmRemoteSignerOnForeground();
      });
    });
    onBeforeUnmount(() => {
      stopAutoLock?.();
      stopForegroundResume?.();
      stopActivityMonitor?.();
      pushPresence?.stop();
      cancelBackgroundTask("preload-post-editor");
      cancelBackgroundTask("preload-bottom-tabs");
      cancelBackgroundTask("foreground-bookmark-sync");
      cancelBackgroundTask("nearby-own-devices");
      disposed = true;
      document.body.classList.remove("login-page", "post-editor-open");
    });
    return {
      call,
      keys,
      ui,
      hideAppChrome,
      isPrimaryRoute,
      isConversationsRoute,
      fabLabel,
      showComposeFab,
      postEditorReady,
      postEditorLoadError,
      preparePostEditor,
      retryPostEditor,
      handleFabIntent,
      handleFabClick,
    };
  }
});
</script>

<style>
body.login-page {
  padding-bottom: 0;
  background: var(--hn-bg);
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
  background: var(--bg-fff);
  color: var(--fg-475569);
  font-size: 14px;
}

.composer-loading-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--bd-cbd5e1);
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
