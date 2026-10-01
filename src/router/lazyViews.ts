export const loadConversationsView = () => import("@/views/Conversations.vue");
export const loadNotificationsView = () => import("@/views/Notifications.vue");
export const loadSettingsView = () => import("@/views/Settings.vue");
export const loadSystemSettingsView = () => import("@/views/SystemSettings.vue");
export const loadFriendsView = () => import("@/views/Friends.vue");
export const loadMyProfileView = () => import("@/views/MyProfile.vue");
export const loadProfileView = () => import("@/views/Profile.vue");
export const loadMessagesView = () => import("@/views/Messages.vue");
export const loadSavedView = () => import("@/views/Saved.vue");

let bottomTabPreload: Promise<unknown> | null = null;

export function preloadBottomTabViews() {
  bottomTabPreload ||= Promise.allSettled([
    loadConversationsView(),
    loadNotificationsView(),
    loadSettingsView(),
    loadSystemSettingsView(),
  ]);
  return bottomTabPreload;
}
