import { reactive } from "vue";

/**
 * Incoming 文件传输助手 records that arrived while the page was closed.
 * Kept apart from nearbySession so the navigation badge does not pull the
 * transfer stack into the startup bundle.
 */
export const nearbyUnread = reactive({ count: 0 });

export function markNearbyUnread() {
  nearbyUnread.count = Math.min(99, nearbyUnread.count + 1);
}

export function clearNearbyUnread() {
  nearbyUnread.count = 0;
}

/** Usable 文件传输助手 devices right now, for the 私信 row subtitle. */
export const nearbyPresence = reactive({ online: 0 });
