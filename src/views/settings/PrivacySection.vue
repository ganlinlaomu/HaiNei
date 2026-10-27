<template>
  <details class="technical-section" open>
    <summary class="section-heading">
      <div><h3>隐私 / Privacy</h3><p>{{ settings.settings.privacy.readReceipts ? "已读回执已开启" : "已读回执已关闭" }}</p></div>
    </summary>
    <div class="account-row">
      <div class="privacy-copy">
        <strong>已读回执</strong>
        <span class="small">关闭后，你不会向好友发送“已读”，同时也不会看到对方的“已读”状态；“已送达”仍会正常显示。</span>
      </div>
      <label class="privacy-toggle">
        <input
          type="checkbox"
          :checked="settings.settings.privacy.readReceipts"
          aria-label="已读回执"
          @change="toggleReadReceipts"
        />
        <span aria-hidden="true"></span>
      </label>
    </div>
  </details>
</template>

<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";

const settings = useSettingsStore();
function toggleReadReceipts(event: Event) {
  settings.setReadReceipts((event.target as HTMLInputElement).checked);
}
</script>

<style scoped src="./systemSettingsSection.css"></style>
<style scoped>
.privacy-copy{display:grid;min-width:0;flex:1;gap:4px}.privacy-copy strong{font-size:.9rem}.privacy-copy .small{line-height:1.45}
.privacy-toggle{position:relative;width:46px;height:28px;flex:0 0 46px;cursor:pointer}.privacy-toggle input{position:absolute;opacity:0;pointer-events:none}.privacy-toggle span{display:block;width:46px;height:28px;border-radius:999px;background:var(--bg-cbd5e1);transition:background 150ms ease}.privacy-toggle span::after{content:"";display:block;width:22px;height:22px;margin:3px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.28);transition:transform 150ms ease}.privacy-toggle input:checked+span{background:#1687e8}.privacy-toggle input:checked+span::after{transform:translateX(18px)}.privacy-toggle input:focus-visible+span{outline:2px solid #2563eb;outline-offset:2px}
</style>
