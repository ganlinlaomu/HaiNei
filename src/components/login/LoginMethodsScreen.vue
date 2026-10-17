<template>
  <section class="hn-screen">
    <div class="hn-body">
      <LoginTopBar :disabled="loading" @back="emit('back')" />
      <h1 class="hn-title">欢迎回来</h1>
      <p class="hn-subtitle">选一种方式找回你的账号。</p>

      <div class="methods">
        <button class="hn-card method" type="button" :disabled="loading" @click="emit('scan')">
          <span class="method-icon" aria-hidden="true">
            <svg class="hn-icon" viewBox="0 0 24 24"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 18.5h3" /><path d="M9.5 7.5h2v2h-2zM12.5 10.5h2v2h-2z" /></svg>
          </span>
          <span class="method-text">
            <strong>用另一台手机扫码</strong>
            <small>在已登录的手机上打开 {{ devicePairPath }}</small>
          </span>
          <svg class="hn-icon arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>

        <button v-if="googleAvailable" class="hn-card method" type="button" :disabled="loading" @click="emit('google')">
          <span class="method-icon" aria-hidden="true">
            <svg class="hn-icon" viewBox="0 0 24 24"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5z" /><path d="M12 10.5v5M9.8 13.3 12 15.5l2.2-2.2" /></svg>
          </span>
          <span class="method-text">
            <strong>从 Google 备份恢复</strong>
            <small>换了新手机，或旧手机不在身边</small>
          </span>
          <svg class="hn-icon arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>

        <button class="hn-card method" type="button" :disabled="loading" @click="emit('private-key')">
          <span class="method-icon" aria-hidden="true">
            <svg class="hn-icon" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2" /></svg>
          </span>
          <span class="method-text">
            <strong>使用私钥登录</strong>
            <small>自己保存过 nsec 私钥</small>
          </span>
          <svg class="hn-icon arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>
      </div>
    </div>
    <div class="hn-actions">
      <slot name="notice" />
      <p class="hn-note">
        没有备份也没有私钥？可以<button class="hn-link hn-link-inline" type="button" :disabled="loading" @click="emit('create')">创建新账号</button>，再请家人重新添加你。
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import LoginTopBar from "./LoginTopBar.vue";

defineProps<{ googleAvailable: boolean; devicePairPath: string; loading?: boolean }>();
const emit = defineEmits<{ back: []; scan: []; google: []; "private-key": []; create: [] }>();
</script>

<style scoped>
.methods {
  display: grid;
  gap: 12px;
  margin-top: 28px;
}

.method {
  display: flex;
  width: 100%;
  min-height: 76px;
  align-items: center;
  gap: 14px;
  padding: 14px 12px 14px 16px;
  border: 1px solid transparent;
  color: var(--hn-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.method:active:not(:disabled) { border-color: var(--hn-primary); }
.method:disabled { cursor: not-allowed; opacity: 0.6; }
.method:focus-visible { outline: 2px solid var(--hn-primary); outline-offset: 2px; }

.method-icon {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  border-radius: 14px;
  background: var(--hn-bg);
  color: var(--hn-primary);
  place-items: center;
}

.method-text {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 3px;
}

.method-text strong { font-size: 16px; font-weight: 600; }
.method-text small { color: var(--hn-text-3); font-size: 13px; line-height: 19px; }
.arrow { width: 20px; height: 20px; flex: 0 0 20px; color: var(--hn-text-3); }

</style>
