import { readFileSync } from "node:fs";
import { join } from "node:path";

let lightTokens: Map<string, string> | null = null;

function tokens() {
  if (lightTokens) return lightTokens;
  const css = readFileSync(join(process.cwd(), "src/theme-tokens.css"), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  lightTokens = new Map([...root.matchAll(/(--[a-z]+-[a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  return lightTokens;
}

/**
 * Reads a source file with dark-mode color tokens replaced by their light
 * values, so visual-contract tests keep asserting the original light colors.
 */
export function readThemedSource(path: string, _encoding: BufferEncoding = "utf8") {
  return readFileSync(path, "utf8").replace(/var\((--(?:fg|bg|bd)-[a-z0-9-]+)\)/g, (match, name: string) => tokens().get(name) ?? match);
}
