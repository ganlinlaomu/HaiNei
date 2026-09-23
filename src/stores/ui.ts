import { defineStore } from "pinia";
import { ref } from "vue";

type Toast = {
  id: number;
  message: string;
  timeout?: number;
  type?: "info" | "success" | "error" | "bookmark";
};

export const useUIStore = defineStore("ui", () => {
  const toasts = ref<Toast[]>([]);
  let nextId = 1;

  function addToast(message: string, timeout = 2000, type: Toast["type"] = "info") {
    const id = nextId++;
    const t: Toast = { id, message, timeout, type };
    toasts.value.push(t);
    if (timeout && timeout > 0) {
      setTimeout(() => removeToast(id), timeout);
    }
    return id;
  }

  function removeToast(id: number) {
    const idx = toasts.value.findIndex(t => t.id === id);
    if (idx !== -1) toasts.value.splice(idx, 1);
  }

  const showPostEditor = ref(false);
  const blockingOverlays = ref(new Set<string>());

  function openPostEditor() {
    showPostEditor.value = true;
  }

  function closePostEditor() {
    showPostEditor.value = false;
  }

  function setBlockingOverlay(name: string, visible: boolean) {
    const next = new Set(blockingOverlays.value);
    if (visible) next.add(name);
    else next.delete(name);
    blockingOverlays.value = next;
  }

  return {
    toasts,
    addToast,
    removeToast,
    showPostEditor,
    openPostEditor,
    closePostEditor,
    blockingOverlays,
    setBlockingOverlay,
  };
});
