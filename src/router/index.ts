import { createRouter, createWebHashHistory, RouteRecordRaw } from "vue-router";
import { nextTick } from "vue";
import Login from "@/views/Login.vue";
import Home from "@/views/Home.vue";
import { loadConversationsView, loadNotificationsView, loadSettingsView } from "@/router/lazyViews";
// Lazy load less frequently accessed views
const Friends = () => import("@/views/Friends.vue");
const MyProfile = () => import("@/views/MyProfile.vue");
const Profile = () => import("@/views/Profile.vue");
const Messages = () => import("@/views/Messages.vue");
const Debug = () => import("@/views/Debug.vue");
const Saved = () => import("@/views/Saved.vue");
const SystemSettings = () => import("@/views/SystemSettings.vue");
import { useKeyStore } from "@/stores/keys";
import { loadHomeScroll, saveHomeScroll } from "@/utils/homeScroll";

/**
 * Central router with route-level auth guard.
 *
 * Behavior:
 * - Routes that require authentication include meta: { requiresAuth: true }.
 * - Global beforeEach checks the key store (pkHex) and redirects to /login if needed.
 * - /login redirects to home if already logged in.
 *
 * Note:
 * - Ensure in src/main.ts you call app.use(createPinia()) before app.use(router)
 *   so the Pinia stores are available inside the navigation guard.
 */

const routes: Array<RouteRecordRaw> = [
  {
    path: "/login",
    name: "Login",
    component: Login,
    meta: { requiresAuth: false, hideHeader: true }
  },
  {
    path: "/",
    name: "Home",
    component: Home,
    meta: { requiresAuth: true }
  },
  {
    path: "/notifications",
    name: "Notifications",
    component: loadNotificationsView,
    meta: { requiresAuth: true }
  },
  {
    path: "/friends",
    name: "Friends",
    component: Friends,
    meta: { requiresAuth: true }
  },
  {
    path: "/conversations",
    name: "Conversations",
    component: loadConversationsView,
    meta: { requiresAuth: true }
  },
  {
    path: "/messages/:pubkey",
    name: "Messages",
    component: Messages,
    meta: { requiresAuth: true, hideBottomNav: true }
  },
  {
    path: "/settings",
    name: "Settings",
    component: loadSettingsView,
    meta: { requiresAuth: true }
  },
  {
    path: "/settings/system",
    name: "SystemSettings",
    component: SystemSettings,
    meta: { requiresAuth: true }
  },
  {
    path: "/settings/profile",
    name: "MyProfile",
    component: MyProfile,
    meta: { requiresAuth: true }
  },
  {
    path: "/settings/saved",
    name: "Saved",
    component: Saved,
    meta: { requiresAuth: true }
  },
  {
    path: "/profile/:pubkey",
    name: "Profile",
    component: Profile,
    meta: { requiresAuth: true }
  },
  {
    path: "/debug",
    name: "Debug",
    component: Debug,
    meta: { requiresAuth: true }
  },
  // fallback
  {
    path: "/:pathMatch(.*)*",
    redirect: "/"
  }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    // If there's a saved position (browser back/forward), use it
    if (savedPosition) {
      return savedPosition;
    }
    // If navigating to a route with a hash (anchor), scroll to it
    if (to.hash) {
      return { el: to.hash, behavior: 'smooth' };
    }
    // For notification jumps with query params, let the component handle the scroll
    if (to.query.mid || to.query.iid) {
      // Return to top but let handleNotificationJump do the actual scroll
      return { top: 0, behavior: 'instant' };
    }
    // Otherwise, scroll to top on navigation
    return { top: 0, behavior: 'instant' };
  }
});

// navigation guard
router.beforeEach(async (to, from, next) => {
  try {
    const keyStore = useKeyStore();
    if (from.path === "/") {
      const appContainer = document.querySelector("body > #app");
      if (appContainer) saveHomeScroll(keyStore.pkHex, appContainer.scrollTop);
    }
    
    // If the store has not loaded its IndexedDB session yet, restore it now.
    if (!keyStore.pkHex && !keyStore.loginMethod) {
      try {
        await keyStore.restoreSession();
      } catch (e) {
        console.error("[router] Failed to restore session:", e);
        // Continue with navigation, will be redirected to login if needed
      }
    }

    const requiresAuth = !!(to.meta && (to.meta as any).requiresAuth);

    if (to.path === "/login") {
      // If already logged in and unlocked, redirect away from login
      if (keyStore.isLoggedIn && keyStore.isUnlocked) {
        return next({ path: "/" });
      }
      // If needs unlock, stay on login page
      return next();
    }

    if (requiresAuth) {
      // Check if user is logged in
      if (!keyStore.isLoggedIn) {
        // not logged in -> go to login
        return next({ path: "/login", query: { redirect: to.fullPath } });
      }
      
      // Check if encrypted key needs unlocking
      if (keyStore.isEncrypted && !keyStore.isUnlocked) {
        // needs unlock -> go to login (unlock screen)
        return next({ path: "/login", query: { redirect: to.fullPath } });
      }
    }
    return next();
  } catch (e) {
    console.error("[router] Navigation guard error:", e);
    // On unexpected errors, be conservative and redirect to login
    return next({ path: "/login" });
  }
});

// After navigation, handle scroll for custom scroll container
router.afterEach((to, from) => {
  // Skip scroll reset for notification jumps (let component handle it)
  if (to.query.mid || to.query.iid) {
    return;
  }
  
  // For normal navigation, scroll the #app container to top
  // Use nextTick to ensure DOM is updated
  nextTick(() => {
    const appContainer = document.querySelector('body > #app');
    if (appContainer) {
      appContainer.scrollTop = to.path === "/"
        ? loadHomeScroll(useKeyStore().pkHex)
        : 0;
    }
  });
});

export default router;
