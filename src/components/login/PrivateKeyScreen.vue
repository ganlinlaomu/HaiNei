<template>
  <form class="hn-screen" @submit.prevent="emit('submit')">
    <div class="hn-body">
      <LoginTopBar :disabled="loading" @back="emit('back')" />
      <h1 class="hn-title">使用私钥登录</h1>
      <p class="hn-subtitle">粘贴你保存的私钥。它只保存在这台手机上，不会上传。</p>

      <div class="hn-field key-field-group">
        <label class="hn-label" for="private-key">私钥</label>
        <div class="key-field">
          <input
            id="private-key"
            ref="keyInput"
            :value="modelValue"
            class="hn-input key-input"
            :type="visible ? 'text' : 'password'"
            placeholder="nsec1…"
            autocapitalize="none"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            inputmode="text"
            :disabled="loading"
            @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
          />
          <button
            class="hn-icon-button visibility"
            type="button"
            :aria-label="visible ? '隐藏私钥' : '显示私钥'"
            :aria-pressed="visible"
            :disabled="loading"
            @click="visible = !visible"
          >
            <svg v-if="visible" class="hn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.2 9.5 6-.5.9-1.6 2.4-3.1 3.7M6.6 7.6C4.7 8.9 3.2 10.7 2.5 12c1 1.8 4.5 6 9.5 6 1.6 0 3-.4 4.3-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
            <svg v-else class="hn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12c1-1.8 4.5-6 9.5-6s8.5 4.2 9.5 6c-1 1.8-4.5 6-9.5 6s-8.5-4.2-9.5-6z" /><circle cx="12" cy="12" r="3" /></svg>
          </button>
        </div>
        <div class="key-meta">
          <button class="hn-btn hn-btn-secondary paste-button" type="button" :disabled="loading" @click="emit('paste')">
            <svg class="hn-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4.5" width="12" height="16" rx="2" /><path d="M9 4.5V3.8A1.3 1.3 0 0 1 10.3 2.5h3.4A1.3 1.3 0 0 1 15 3.8v.7" /></svg>
            粘贴
          </button>
          <span v-if="recognized" class="recognized" role="status">
            <svg class="hn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
            已识别 {{ recognized }} 私钥
          </span>
        </div>
      </div>
    </div>
    <div class="hn-actions">
      <slot name="notice" />
      <button class="hn-btn hn-btn-primary" type="submit" :disabled="loading">{{ loading ? "正在登录…" : "登录" }}</button>
      <p class="hn-note hn-small">登录后会在这台手机上保持登录，可在设置中开启 {{ biometricName }} 保护</p>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import LoginTopBar from "./LoginTopBar.vue";

const props = defineProps<{ modelValue: string; biometricName: string; loading?: boolean }>();
const emit = defineEmits<{ back: []; submit: []; paste: []; "update:modelValue": [value: string] }>();
const visible = ref(false);
const keyInput = ref<HTMLInputElement | null>(null);

const recognized = computed(() => {
  const value = props.modelValue.trim();
  if (/^nsec1[02-9ac-hj-np-z]{58}$/.test(value)) return "nsec";
  if (/^[0-9a-fA-F]{64}$/.test(value)) return "hex";
  return "";
});

onMounted(() => keyInput.value?.focus());
</script>

<style scoped>
.key-field-group { margin-top: 28px; }
.key-field { position: relative; }
.key-input { padding-right: 56px; font-family: var(--hn-font-mono); font-size: 16px; }

.visibility {
  position: absolute;
  top: 5px;
  right: 5px;
  color: var(--hn-text-2);
}

.key-meta {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.paste-button {
  width: auto;
  min-height: 44px;
  padding: 0 16px;
  font-size: 15px;
}

.paste-button .hn-icon { width: 18px; height: 18px; }

.recognized {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--hn-success);
  font-size: 14px;
  font-weight: 600;
}

.recognized .hn-icon { width: 18px; height: 18px; stroke-width: 2.2; }
</style>
