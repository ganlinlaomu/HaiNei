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
