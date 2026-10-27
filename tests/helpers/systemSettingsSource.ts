import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SystemSettings.vue plus its section components and shared section CSS
 * (src/views/settings/), read as one source: contract tests assert what the
 * settings page contains, wherever a section now lives.
 */
export function readSystemSettingsSource(transform: (text: string) => string = text => text) {
  const root = process.cwd();
  const dir = join(root, "src/views/settings");
  const parts = [join(root, "src/views/SystemSettings.vue"), ...readdirSync(dir).sort().map(name => join(dir, name))];
  return parts.map(path => transform(readFileSync(path, "utf8"))).join("\n");
}
