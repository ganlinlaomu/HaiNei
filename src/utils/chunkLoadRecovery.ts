import type { Router } from "vue-router";

// After a deploy the activated service worker drops the previous asset cache
// and the host no longer serves the old hashed chunks. A page still running the
// previous bundle then fails every lazy import until it reloads.
const RELOAD_GUARD_KEY = "hainei-stale-chunk-reload-at";
const RELOAD_GUARD_MS = 10_000;
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

export function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return CHUNK_ERROR.test(message);
}

/** Reload at most once per guard window so a genuinely missing chunk cannot loop. */
export function reloadForStaleChunk(targetHref?: string) {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // Without session storage there is no loop guard; still try once.
  }
  try {
    if (targetHref) window.history.replaceState(window.history.state, "", targetHref);
  } catch {
    // Reloading the current route is still better than a dead navigation.
  }
  window.location.reload();
  return true;
}

export function installChunkLoadRecovery(router: Router) {
  window.addEventListener("vite:preloadError", event => {
    if (reloadForStaleChunk()) event.preventDefault();
  });
  router.onError((error, to) => {
    if (isChunkLoadError(error)) reloadForStaleChunk(router.resolve(to).href);
  });
}
