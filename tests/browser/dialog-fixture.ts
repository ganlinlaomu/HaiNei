import { createApp, h, ref } from "vue";
import { createPinia } from "pinia";
import NewConversationSheet from "@/components/NewConversationSheet.vue";
createApp({
  setup() {
    const visible = ref(false);
    return () =>
      h("main", [
        h(
          "button",
          {
            onClick: () => {
              visible.value = true;
            },
          },
          "新私信",
        ),
        h(NewConversationSheet, {
          visible: visible.value,
          onClose: () => {
            visible.value = false;
          },
        }),
      ]);
  },
})
  .use(createPinia())
  .mount("#app");
