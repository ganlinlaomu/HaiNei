export const DEFAULT_HAINEI_WORKER_URL = "https://hainei-media.noster.workers.dev";

export function resolveHaiNeiWorkerBaseUrl(
  configuredUrl: string | undefined,
  pageOrigin: string,
  isProduction: boolean,
) {
  const configured = String(configuredUrl || "").trim();
  const fallback = isProduction ? DEFAULT_HAINEI_WORKER_URL : pageOrigin;
  return String(configured || fallback).trim().replace(/\/+$/, "");
}

export function haineiWorkerBaseUrl() {
  const pageOrigin = typeof window !== "undefined" ? window.location.origin : "";
  return resolveHaiNeiWorkerBaseUrl(
    import.meta.env.VITE_HAINEI_WORKER_URL,
    pageOrigin,
    import.meta.env.PROD,
  );
}
