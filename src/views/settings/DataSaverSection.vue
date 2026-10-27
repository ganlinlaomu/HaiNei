<template>
  <details class="technical-section">
    <summary class="section-heading">
      <div><h3>数据使用 / Data Saver</h3><p>{{ settings.dataSaver ? "节省流量" : "标准" }}</p></div>
    </summary>
    <div class="data-mode" role="radiogroup" aria-label="数据使用模式">
      <label><input type="radio" :checked="!settings.dataSaver" @change="settings.setDataSaver(false)" /> 标准</label>
      <label><input type="radio" :checked="settings.dataSaver" @change="settings.setDataSaver(true)" /> 节省流量</label>
    </div>
    <p class="section-detail">节省流量模式会缩短图片预加载距离，并避免不必要的视频预加载。</p>
  </details>
</template>

<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";

const settings = useSettingsStore();
</script>

<style scoped src="./systemSettingsSection.css"></style>
