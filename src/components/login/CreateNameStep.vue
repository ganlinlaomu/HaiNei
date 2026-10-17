<template>
  <form class="hn-screen" @submit.prevent="submit">
    <div class="hn-body">
      <LoginTopBar :progress="1" :disabled="loading" @back="emit('back')" />
      <h1 class="hn-title">怎么称呼你？</h1>
      <p class="hn-subtitle">家人和朋友会看到这个名字，之后可以随时修改。</p>

      <label class="avatar-picker">
        <span class="avatar-circle" :class="{ filled: !!avatarPreview }">
          <img v-if="avatarPreview" :src="avatarPreview" alt="" />
          <svg v-else class="hn-icon camera" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.4-2h5.2L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
            <circle cx="12" cy="12.5" r="3.5" />
          </svg>
        </span>
        <span class="avatar-caption">{{ avatarPreview ? "更换头像" : "添加头像（可选）" }}</span>
        <input class="avatar-input" type="file" accept="image/*" :disabled="loading" @change="pickAvatar" />
      </label>

      <label class="hn-field">
        <span class="hn-label">名字</span>
        <input
          ref="nameInput"
          :value="name"
          class="hn-input"
          maxlength="40"
          autocomplete="nickname"
          enterkeyhint="next"
          placeholder="例如：小雨"
          :disabled="loading"
          @input="emit('update:name', ($event.target as HTMLInputElement).value)"
        />
      </label>
    </div>
    <div class="hn-actions">
      <slot name="notice" />
      <button class="hn-btn hn-btn-primary" type="submit" :disabled="loading || !name.trim()">下一步</button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import LoginTopBar from "./LoginTopBar.vue";

const props = defineProps<{ name: string; avatarPreview: string; loading?: boolean }>();
const emit = defineEmits<{
  back: [];
  next: [];
  "update:name": [value: string];
  "update:avatar": [file: File | null];
}>();
const nameInput = ref<HTMLInputElement | null>(null);

onMounted(() => {
  if (!props.name) nameInput.value?.focus();
});

function pickAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] || null;
  if (file && !file.type.startsWith("image/")) return;
  emit("update:avatar", file);
  input.value = "";
}

function submit() {
  if (props.loading || !props.name.trim()) return;
  emit("next");
}
</script>

<style scoped>
.avatar-picker {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 10px;
  margin: 32px auto 28px;
  cursor: pointer;
}

.avatar-circle {
  display: grid;
  overflow: hidden;
  width: 96px;
  height: 96px;
  border: 1.5px dashed var(--hn-text-3);
  border-radius: 50%;
  background: var(--hn-card);
  color: var(--hn-text-2);
  place-items: center;
}

.avatar-circle.filled { border-style: solid; border-color: transparent; }
.avatar-circle img { width: 100%; height: 100%; object-fit: cover; }
.camera { width: 30px; height: 30px; }

.avatar-caption {
  color: var(--hn-text-2);
  font-size: 14px;
}

.avatar-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.avatar-picker:focus-within .avatar-circle { outline: 2px solid var(--hn-primary); outline-offset: 3px; }
</style>
