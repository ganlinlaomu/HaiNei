<template>
  <div class="app-root">
    <UpdateNotification />
    <HeaderBar />
    <router-view v-slot="{ Component }">
      <keep-alive :include="['Home', 'Friends', 'Notifications', 'Settings']">
        <component :is="Component" />
      </keep-alive>
    </router-view>
    <ToastContainer />
    <PostEditorModal v-if="ui.showPostEditor" />
  </div>
</template>

<script lang="ts">
import { defineAsyncComponent, defineComponent } from "vue";
import HeaderBar from "@/components/HeaderBar.vue";
import ToastContainer from "@/components/ToastContainer.vue";
import UpdateNotification from "@/components/UpdateNotification.vue";
import { useUIStore } from "@/stores/ui";

const PostEditorModal = defineAsyncComponent(() => import("@/components/PostEditorModal.vue"));

export default defineComponent({
  components: { HeaderBar, ToastContainer, PostEditorModal, UpdateNotification },
  setup() {
    return { ui: useUIStore() };
  }
});
</script>
