<template>
  <details class="technical-section">
    <summary class="section-heading">
      <div class="section-heading-main">
        <span class="section-heading-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </span>
        <div>
          <h3>外观 / Appearance</h3>
          <p>{{ themeLabel }}</p>
        </div>
      </div>
    </summary>
    <div class="data-mode" role="radiogroup" aria-label="外观">
      <label><input type="radio" name="theme" :checked="themePreference === 'system'" @change="setThemePreference('system')" /> 跟随系统</label>
      <label><input type="radio" name="theme" :checked="themePreference === 'light'" @change="setThemePreference('light')" /> 浅色</label>
      <label><input type="radio" name="theme" :checked="themePreference === 'dark'" @change="setThemePreference('dark')" /> 深色</label>
    </div>
    <p class="section-detail">只对这台设备生效。「跟随系统」会随手机的深色模式自动切换。</p>
  </details>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { setThemePreference, themePreference } from "@/services/theme";

const themeLabel = computed(() => ({ system: "跟随系统", light: "浅色", dark: "深色" })[themePreference.value]);
</script>

<style scoped src="./systemSettingsSection.css"></style>
