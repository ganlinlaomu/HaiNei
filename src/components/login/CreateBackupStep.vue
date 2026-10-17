<template>
  <section class="hn-screen">
    <div class="hn-body">
      <LoginTopBar :progress="2" :disabled="loading" @back="emit('back')" />
      <h1 class="hn-title">保护你的账号</h1>
      <p class="hn-subtitle">换手机或手机丢了，用备份就能找回所有照片和聊天。</p>

      <article v-if="googleAvailable" class="hn-card backup-card">
        <div class="backup-card-head">
          <span class="backup-icon" aria-hidden="true">
            <svg class="hn-icon" viewBox="0 0 24 24"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5z" /><path d="M12 15.5v-5M9.8 12.4 12 10.2l2.2 2.2" /></svg>
          </span>
          <strong>备份到 Google 账号</strong>
          <span class="badge">推荐</span>
        </div>
        <p>先在手机上加密再保存，Google 和海内都看不到内容。新手机上登录同一个 Google 账号即可恢复。</p>
      </article>
      <article v-else class="hn-card backup-card">
        <div class="backup-card-head">
          <span class="backup-icon" aria-hidden="true">
            <svg class="hn-icon" viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6z" /></svg>
          </span>
          <strong>稍后备份也可以</strong>
        </div>
        <p>这台设备暂不支持 Google 备份。进入后可以用另一台手机扫码添加设备，或在下方自己保存私钥。</p>
      </article>

      <button
        class="hn-btn hn-btn-text advanced-toggle"
        type="button"
        :aria-expanded="showAdvanced"
        aria-controls="advanced-key"
        @click="showAdvanced = !showAdvanced"
      >
        我想自己保存私钥（高级）
        <svg class="hn-icon chevron" :class="{ open: showAdvanced }" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>

      <article v-if="showAdvanced" id="advanced-key" class="hn-card key-card">
        <p class="key-warning">
          <svg class="hn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.5 20h19z" /><path d="M12 10v4.5M12 17.2v.1" /></svg>
          任何人拿到私钥都能读你的消息、冒充你。请抄在纸上或存进密码管理器。
        </p>
        <code class="key-value">{{ nsec }}</code>
        <button class="hn-btn hn-btn-secondary copy-button" type="button" @click="copyKey">
          <svg class="hn-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
          {{ copied ? "已复制" : "复制私钥" }}
        </button>
      </article>
    </div>

    <div class="hn-actions">
      <slot name="notice" />
      <button v-if="googleAvailable" class="hn-btn hn-btn-primary" type="button" :disabled="loading" @click="emit('google')">
        {{ loading ? "正在进入…" : "用 Google 备份并进入" }}
      </button>
      <button v-else class="hn-btn hn-btn-primary" type="button" :disabled="loading" @click="emit('skip')">
        {{ loading ? "正在进入…" : "进入海内" }}
      </button>
      <button v-if="googleAvailable" class="hn-btn hn-btn-secondary" type="button" :disabled="loading" @click="emit('skip')">稍后再说</button>
      <p class="hn-note hn-small">随时可在 设置 › 账号安全 中备份</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue";
import LoginTopBar from "./LoginTopBar.vue";

const props = defineProps<{ nsec: string; googleAvailable: boolean; loading?: boolean }>();
const emit = defineEmits<{ back: []; google: []; skip: []; "copy-failed": [] }>();
const showAdvanced = ref(false);
const copied = ref(false);

async function copyKey() {
  try {
    await navigator.clipboard.writeText(props.nsec);
    copied.value = true;
  } catch {
    emit("copy-failed");
  }
}
</script>

<style scoped>
.backup-card {
  margin-top: 28px;
  padding: 18px;
}

.backup-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.backup-card-head strong {
  flex: 1;
  font-size: 16px;
}

.backup-icon {
  display: grid;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  border-radius: 12px;
  background: var(--hn-bg);
  color: var(--hn-primary);
  place-items: center;
}

.badge {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--hn-primary);
  color: var(--hn-on-primary);
  font-size: 12px;
  font-weight: 600;
}

.backup-card p {
  margin: 12px 0 0;
  color: var(--hn-text-2);
  font-size: 14px;
  line-height: 22px;
}

.advanced-toggle {
  margin-top: 16px;
  font-size: 14px;
}

.chevron { width: 18px; height: 18px; transition: transform 160ms ease; }
.chevron.open { transform: rotate(180deg); }

.key-card {
  display: grid;
  gap: 14px;
  margin-top: 4px;
  padding: 16px;
}

.key-warning {
  display: flex;
  gap: 8px;
  margin: 0;
  padding: 12px;
  border-radius: 12px;
  background: var(--hn-danger-bg);
  color: var(--hn-danger);
  font-size: 13px;
  line-height: 20px;
}

.key-warning .hn-icon { width: 20px; height: 20px; flex: 0 0 20px; }

.key-value {
  display: block;
  padding: 12px;
  border-radius: 12px;
  background: var(--hn-bg);
  color: var(--hn-text);
  font-family: var(--hn-font-mono);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
  user-select: all;
}

.copy-button { min-height: 48px; font-size: 15px; }
.copy-button .hn-icon { width: 20px; height: 20px; }
</style>
