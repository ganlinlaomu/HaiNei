let postEditorModule: Promise<typeof import("./PostEditorModal.vue")> | null = null;

/** Share one preload promise between idle warm-up and navigation interaction. */
export function loadPostEditor() {
  if (!postEditorModule) {
    postEditorModule = import("./PostEditorModal.vue").catch(error => {
      postEditorModule = null;
      throw error;
    });
  }
  return postEditorModule;
}

export function preloadPostEditor() {
  void loadPostEditor().catch(() => {
    // App.vue exposes a visible retry state if the user opens the composer.
  });
}
