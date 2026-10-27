<template>
  <details class="technical-section">
    <summary class="section-heading">
      <div>
        <h3>图片与视频 / Media</h3>
        <p>{{ mediaList.filter(server => server.enabled).length }} 个已启用 · Primary 与 fallback</p>
      </div>
    </summary>
    <p class="section-detail">按 Primary、其他用户服务器、默认 fallback 的顺序上传。媒体服务器仅支持 HTTPS；localhost 可用于本地调试。</p>

    <form class="media-add-form" @submit.prevent="addMediaServer">
      <select v-model="newMediaType" class="input compact-input">
        <option value="blossom">Blossom</option>
        <option value="imgbed">ImgBed</option>
        <option value="custom">Custom</option>
      </select>
      <input
        v-model="newMediaUrl"
        class="input"
        inputmode="url"
        autocapitalize="none"
        autocomplete="off"
        placeholder="https://media.example.com"
      />
      <button class="btn btn-primary" type="submit">添加</button>
    </form>

    <div class="item-list">
      <article v-for="server in mediaList" :key="server.id" class="item-card">
        <div class="item-header">
          <div class="item-main">
            <div class="item-url">{{ server.url }}</div>
            <div class="meta-row">
              <span class="pill">{{ mediaTypeLabel(server.type) }}</span>
              <span class="pill">{{ server.source === "user" ? "用户" : "默认" }}</span>
              <span v-if="primaryMediaId === server.id" class="pill primary">Primary</span>
              <span v-else-if="server.source === 'default'" class="pill">Fallback</span>
            </div>
          </div>
          <button
            v-if="!isBuiltinMedia(server)"
            class="text-button danger"
            type="button"
            @click="removeMediaServer(server)"
          >
            删除
          </button>
        </div>

        <div class="health-grid">
          <span>最近成功：{{ formatTimestamp(server.lastSuccessAt) }}</span>
          <span>最近失败：{{ formatTimestamp(server.lastFailureAt) }}</span>
        </div>

        <div class="control-row">
          <label><input type="checkbox" :checked="server.enabled" @change="toggleMediaServer(server, $event)" />启用</label>
          <button
            v-if="server.source === 'user' && server.enabled && primaryMediaId !== server.id"
            class="text-button"
            type="button"
            @click="settings.setPrimaryMediaServer(server.id)"
          >
            设为 Primary
          </button>
        </div>
      </article>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { MediaServer, MediaServerType } from "@/services/connectionSettings";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";
import { formatTimestamp } from "./settingsFormat";

const settings = useSettingsStore();
const ui = useUIStore();
const mediaList = computed(() => settings.mediaList);
const primaryMediaId = computed(() =>
  settings.activeMediaServers.find(server => server.source === "user")?.id || ""
);
const newMediaType = ref<MediaServerType>("blossom");
const newMediaUrl = ref("");

function mediaTypeLabel(type: MediaServerType) {
  return type === "blossom" ? "Blossom" : type === "imgbed" ? "ImgBed" : "Custom";
}
function isBuiltinMedia(server: MediaServer) {
  return server.source === "default";
}
function showValidationError(fallback: string) {
  ui.addToast(settings.validationError || fallback, 2_500, "error");
}
function addMediaServer() {
  if (!settings.addMediaServer(newMediaType.value, newMediaUrl.value)) {
    showValidationError("请输入有效的媒体服务器地址");
    return;
  }
  newMediaUrl.value = "";
}
function removeMediaServer(server: MediaServer) {
  if (!confirm(`确定要删除 ${server.url} 吗？`)) return;
  if (!settings.deleteMediaServer(server.id)) {
    showValidationError("删除媒体服务器失败");
  }
}
function toggleMediaServer(server: MediaServer, event: Event) {
  if (!settings.updateMediaServer(server.id, { enabled: (event.target as HTMLInputElement).checked })) {
    showValidationError("更新媒体服务器失败");
  }
}
</script>

<style scoped src="./systemSettingsSection.css"></style>
<style scoped>
.health-grid {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  color: var(--fg-64748b);
  font-size: 0.7rem;
}
@media (max-width: 640px) {
  .health-grid {
    grid-template-columns: 1fr;
  }
}
</style>
