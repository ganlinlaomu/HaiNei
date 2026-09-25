export const loadConversationsView = () => import("@/views/Conversations.vue");
export const loadNotificationsView = () => import("@/views/Notifications.vue");
export const loadSettingsView = () => import("@/views/Settings.vue");

let bottomTabPreload: Promise<unknown> | null = null;

export function preloadBottomTabViews() {
  bottomTabPreload ||= Promise.allSettled([
    loadConversationsView(),
    loadNotificationsView(),
    loadSettingsView(),
  ]);
  return bottomTabPreload;
}
