import { yieldToMainThread } from "@/services/backgroundWorkScheduler";

export const loadConversationsView = () => import("@/views/Conversations.vue");
export const loadNotificationsView = () => import("@/views/Notifications.vue");
export const loadSettingsView = () => import("@/views/Settings.vue");
export const loadSystemSettingsView = () => import("@/views/SystemSettings.vue");
export const loadMessagesView = () => import("@/views/Messages.vue");
export const loadProfileView = () => import("@/views/Profile.vue");
export const loadFriendsView = () => import("@/views/Friends.vue");
export const loadMyProfileView = () => import("@/views/MyProfile.vue");
export const loadSavedView = () => import("@/views/Saved.vue");
export const loadPrivateSpaceView = () => import("@/views/PrivateSpace.vue");

let bottomTabPreload: Promise<PromiseSettledResult<unknown>[]> | null = null;

async function preloadBottomTabsInBatches() {
  const loaders = [
    // Warm the common navigation path in small idle batches. Messages is
    // included immediately after the conversation list so the first chat open
    // does not pay a cold chunk parse cost.
    loadSettingsView,
    loadConversationsView,
    loadMessagesView,
    loadNotificationsView,
    loadFriendsView,
    loadSystemSettingsView,
  ];
  const results: PromiseSettledResult<unknown>[] = [];

  for (let index = 0; index < loaders.length; index += 1) {
    try {
      results.push({ status: "fulfilled", value: await loaders[index]() });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
    if (index < loaders.length - 1) await yieldToMainThread();
  }

  return results;
}

export function preloadBottomTabViews() {
  bottomTabPreload ||= preloadBottomTabsInBatches();
  return bottomTabPreload;
}
