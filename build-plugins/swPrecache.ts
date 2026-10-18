import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export const PRECACHE_MARKER = "const PRECACHE_ASSETS = []; // filled in by build-plugins/swPrecache.ts";

/** Hashed JS/CSS chunks the app may lazy-load; source maps are never shipped. */
export function precacheAssetList(fileNames: string[]) {
  return [...new Set(fileNames)]
    .filter(name => /\.(?:js|css)$/.test(name) && !name.endsWith(".map"))
    .map(name => `/${name.replace(/^\/+/, "")}`)
    .sort();
}

export function injectPrecacheList(serviceWorker: string, assets: string[]) {
  if (!serviceWorker.includes(PRECACHE_MARKER)) throw new Error("service-worker.js is missing the precache marker");
  return serviceWorker.replace(PRECACHE_MARKER, `const PRECACHE_ASSETS = ${JSON.stringify(assets)};`);
}

/**
 * Lazy-loaded views (私人空间, 私信详情, …) used to be cached only after a
 * first online visit, and each release starts a fresh cache. Write every
 * emitted chunk into dist/service-worker.js so install caches them all and
 * any page opens offline.
 */
export function swPrecachePlugin(): Plugin {
  let outDir = "dist";
  const emitted: string[] = [];
  return {
    name: "hainei-sw-precache",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      emitted.push(...Object.keys(bundle));
    },
    closeBundle() {
      const swPath = path.join(outDir, "service-worker.js");
      if (!existsSync(swPath)) return;
      writeFileSync(swPath, injectPrecacheList(readFileSync(swPath, "utf8"), precacheAssetList(emitted)));
    },
  };
}
