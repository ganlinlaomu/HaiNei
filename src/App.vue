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
    <PostEditorModal v-if="!hideAppChrome && ui.showPostEditor" />
  </div>
</template>

<script lang="ts">
import { computed, defineAsyncComponent, defineComponent, onBeforeUnmount, watch } from "vue";
import { useRoute } from "vue-router";
import HeaderBar from "@/components/HeaderBar.vue";
import ToastContainer from "@/components/ToastContainer.vue";
import UpdateNotification from "@/components/UpdateNotification.vue";
import { useUIStore } from "@/stores/ui";

const PostEditorModal = defineAsyncComponent(() => import("@/components/PostEditorModal.vue"));

export default defineComponent({
  components: { HeaderBar, ToastContainer, PostEditorModal, UpdateNotification },
  setup() {
    const route = useRoute();
    const hideAppChrome = computed(() => route.meta.hideHeader === true);
    watch(
      hideAppChrome,
      (hidden) => document.body.classList.toggle("login-page", hidden),
      { immediate: true }
    );
    onBeforeUnmount(() => document.body.classList.remove("login-page"));
    return { ui: useUIStore(), hideAppChrome };
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
</style>
