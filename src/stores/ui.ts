import { defineStore } from "pinia";
import { ref } from "vue";

type Toast = {
  id: number;
  message: string;
  timeout?: number;
  type?: "info" | "success" | "error";
  action?: ToastAction;
};

export type ToastAction = { label: string; run: () => void };

export const useUIStore = defineStore("ui", () => {
  const toasts = ref<Toast[]>([]);
  let nextId = 1;

  function addToast(message: string, timeout = 2000, type: Toast["type"] = "info", action?: ToastAction) {
    const id = nextId++;
    const t: Toast = { id, message, timeout, type, ...(action ? { action } : {}) };
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
  const showNewConversation = ref(false);
  const blockingOverlays = ref(new Set<string>());

  /** Composer type to preselect on the next open (e.g. 新待办 from the to-do bar). */
  const postEditorType = ref<"post" | "note" | "todo" | null>(null);
  function openPostEditor(type?: "post" | "note" | "todo") {
    postEditorType.value = type || null;
    showPostEditor.value = true;
  }

  function closePostEditor() {
    showPostEditor.value = false;
  }

  function openNewConversation() {
    showNewConversation.value = true;
  }

  function closeNewConversation() {
    showNewConversation.value = false;
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
    postEditorType,
    closePostEditor,
    showNewConversation,
    openNewConversation,
    closeNewConversation,
    blockingOverlays,
    setBlockingOverlay,
  };
});
