import { waitForIdle } from "@/services/backgroundWorkScheduler";

export const loadConversationsView = () => import("@/views/Conversations.vue");
export const loadCallsView = () => import("@/views/Calls.vue");
export const loadNotificationsView = () => import("@/views/Notifications.vue");
export const loadSettingsView = () => import("@/views/Settings.vue");
export const loadSystemSettingsView = () => import("@/views/SystemSettings.vue");
export const loadMessagesView = () => import("@/views/Messages.vue");
export const loadProfileView = () => import("@/views/Profile.vue");
export const loadFriendsView = () => import("@/views/Friends.vue");
export const loadMyProfileView = () => import("@/views/MyProfile.vue");
export const loadSavedView = () => import("@/views/Saved.vue");
export const loadPrivateSpaceView = () => import("@/views/PrivateSpace.vue");
export const loadBooksView = () => import("@/views/Books.vue");
export const loadEbookReaderView = () => import("@/views/EbookReader.vue");

let bottomTabPreload: Promise<PromiseSettledResult<unknown>[]> | null = null;

async function preloadBottomTabsInBatches() {
  const loaders = [
    // Warm the common navigation path one view per idle moment. The
    // conversation list and chat come first: they are the next tap after a
    // notification and the costliest to parse cold.
    loadConversationsView,
    loadMessagesView,
    loadCallsView,
    loadFriendsView,
    loadSettingsView,
    loadNotificationsView,
    loadSystemSettingsView,
  ];
  const results: PromiseSettledResult<unknown>[] = [];

  for (let index = 0; index < loaders.length; index += 1) {
    try {
      results.push({ status: "fulfilled", value: await loaders[index]() });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
    // Re-check idleness before every view: scrolling or tapping since the
    // previous one postpones the rest.
    if (index < loaders.length - 1) await waitForIdle();
  }

  return results;
}

export function preloadBottomTabViews() {
  bottomTabPreload ||= preloadBottomTabsInBatches();
  return bottomTabPreload;
}
