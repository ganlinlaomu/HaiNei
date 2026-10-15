import { ref } from "vue";
import { deviceStorage } from "@/services/deviceStorage";

/** Device-wide (not per account): it must already apply on the login screen. */
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "hainei_theme";
const LIGHT_THEME_COLOR = "#0f172a";
const DARK_THEME_COLOR = "#0e0f12";

export const themePreference = ref<ThemePreference>("system");
let systemListenerInstalled = false;

function readPreference(): ThemePreference {
  const value = deviceStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

function systemPrefersDark() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

export function resolvedTheme(preference = themePreference.value): "light" | "dark" {
  return preference === "system" ? (systemPrefersDark() ? "dark" : "light") : preference;
}

function syncThemeColorMeta() {
  if (typeof document === "undefined") return;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", resolvedTheme() === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
}

function applyToDocument(preference: ThemePreference) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // "system" leaves the attribute unset so the prefers-color-scheme media
  // query in theme-tokens.css decides, including before any script runs.
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
  syncThemeColorMeta();
}

/** Call once after device storage is hydrated and before the app mounts. */
export function initTheme() {
  themePreference.value = readPreference();
  applyToDocument(themePreference.value);
  if (!systemListenerInstalled && typeof window !== "undefined" && window.matchMedia) {
    systemListenerInstalled = true;
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", syncThemeColorMeta);
  }
}

export function setThemePreference(preference: ThemePreference) {
  themePreference.value = preference;
  if (preference === "system") deviceStorage.removeItem(STORAGE_KEY);
  else deviceStorage.setItem(STORAGE_KEY, preference);
  applyToDocument(preference);
}
