<template>
  <div class="app-root" :class="{ 'login-route': hideAppChrome }">
    <UpdateNotification />
    <HeaderBar v-if="!hideAppChrome" />
    <router-view v-slot="{ Component }">
      <keep-alive :include="['Home', 'Friends', 'Notifications', 'Settings']">
        <component :is="Component" />
      </keep-alive>
    </router-view>
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
import { loadPostEditor } from "@/components/postEditorLoader";

const PostEditorModal = defineAsyncComponent(loadPostEditor);

export default defineComponent({
  components: { HeaderBar, ToastContainer, PostEditorModal, UpdateNotification },
  setup() {
    const route = useRoute();
    const ui = useUIStore();
    const postEditorReady = ref(false);
    const postEditorLoadError = ref(false);
    const hideAppChrome = computed(() => route.meta.hideHeader === true);
    let disposed = false;
    let idleHandle: number | null = null;

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
    onMounted(schedulePostEditorWarmup);
    onBeforeUnmount(() => {
      disposed = true;
      if (idleHandle !== null) {
        const cancelIdle = (window as any).cancelIdleCallback as undefined | ((handle: number) => void);
        if (cancelIdle) cancelIdle(idleHandle);
        else window.clearTimeout(idleHandle);
      }
      document.body.classList.remove("login-page", "post-editor-open");
    });
    return { ui, hideAppChrome, postEditorReady, postEditorLoadError, preparePostEditor };
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

.composer-loading-overlay {
  position: fixed;
  inset: 0 0 calc(80px + env(safe-area-inset-bottom)) 0;
  z-index: 2000;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 23, 42, 0.38);
}

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

@media (min-width: 720px) {
  .composer-loading-overlay { align-items: center; }
}
</style>
