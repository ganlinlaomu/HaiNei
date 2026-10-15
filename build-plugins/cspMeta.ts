import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/**
 * The Android (Capacitor) build serves dist/ from the device, so the
 * Content-Security-Policy in public/_headers (Cloudflare Pages only) never
 * applies there. Inject the same policy as a <meta> tag into production
 * builds. frame-ancestors is not supported in <meta> and is dropped.
 */
export function cspFromHeaders(headers: string): string {
  const line = headers.split(/\r?\n/).map(value => value.trim())
    .find(value => value.toLowerCase().startsWith("content-security-policy:"));
  if (!line) throw new Error("public/_headers has no Content-Security-Policy");
  return line.slice(line.indexOf(":") + 1)
    .split(";")
    .map(directive => directive.trim())
    .filter(directive => directive && !/^frame-ancestors\b/i.test(directive))
    .join("; ");
}

export function cspMetaPlugin(headersPath: string): Plugin {
  return {
    name: "hainei-csp-meta",
    apply: "build",
    transformIndexHtml() {
      const policy = cspFromHeaders(readFileSync(headersPath, "utf8"));
      return [{
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: policy },
        injectTo: "head-prepend",
      }];
    },
  };
}
