// SystemSettings.vue's self-contained sections now live in src/views/settings.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { createPinia } from "pinia";
import PrivacySection from "@/views/settings/PrivacySection.vue";
import AppearanceSection from "@/views/settings/AppearanceSection.vue";
import DataSaverSection from "@/views/settings/DataSaverSection.vue";
import PushSection from "@/views/settings/PushSection.vue";

function render(component: Component, props: Record<string, unknown> = {}) {
  const app = createSSRApp({ render: () => h(component, props) });
  app.use(createPinia());
  return renderToString(app);
}

describe("system settings sections", () => {
  it("render on their own with the same headings as before", async () => {
    expect(await render(PrivacySection)).toContain("隐私 / Privacy");
    expect(await render(AppearanceSection)).toContain("外观 / Appearance");
    expect(await render(DataSaverSection)).toContain("数据使用 / Data Saver");
  });

  it("shows the native placeholder instead of Web Push controls in the APK", async () => {
    const native = await render(PushSection, { isNativeApp: true });
    expect(native).toContain("后台推送 / Android Push");
    expect(native).toContain("原生 Push 待启用");
    expect(native).not.toContain("开启推送");
  });

  it("keeps every styled class styled in the file that uses it, the page included", () => {
    // Scoped styles do not reach another component, so a class used in a
    // template needs its rules in that file or in the shared section CSS.
    // (v0.1.158 moved .privacy-copy into PrivacySection while the page's
    // account rows still used it.)
    const dir = join(process.cwd(), "src/views/settings");
    const shared = readFileSync(join(dir, "systemSettingsSection.css"), "utf8");
    const files = [join(process.cwd(), "src/views/SystemSettings.vue"),
      ...readdirSync(dir).filter(name => name.endsWith(".vue")).map(name => join(dir, name))];
    const cssClasses = (css: string) => new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1]));
    const ownCss = (source: string) => [...source.matchAll(/<style scoped>([\s\S]*?)<\/style>/g)].map(match => match[1]).join("\n");
    const styled = cssClasses(shared + files.map(file => ownCss(readFileSync(file, "utf8"))).join("\n"));
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const template = source.slice(0, source.indexOf("</template>"));
      const used = [...template.matchAll(/\bclass="([^"]+)"/g)].flatMap(match => match[1].split(/\s+/));
      const available = cssClasses(shared + ownCss(source));
      const missing = [...new Set(used.filter(name => styled.has(name) && !available.has(name)))];
      expect(missing, file).toEqual([]);
    }
  });

  it("every section includes the shared section styles scoped, and the page mounts them all", () => {
    const dir = join(process.cwd(), "src/views/settings");
    const sections = readdirSync(dir).filter(name => name.endsWith("Section.vue"));
    expect(sections.length).toBeGreaterThanOrEqual(7);
    const page = readFileSync(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");
    expect(page).toContain('<style scoped src="./settings/systemSettingsSection.css"></style>');
    for (const name of sections) {
      expect(readFileSync(join(dir, name), "utf8"), name).toContain('<style scoped src="./systemSettingsSection.css"></style>');
      expect(page, name).toContain(`<${name.replace(".vue", "")}`);
    }
  });
});
