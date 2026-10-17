<template>
  <main class="welcome">
    <LoginIllustration />
    <section class="welcome-actions">
      <p class="tagline">只给家人和朋友的地方</p>
      <button class="hn-btn hn-btn-primary" type="button" @click="emit('start')">注册</button>
      <button class="hn-btn hn-btn-secondary" type="button" @click="emit('have-account')">我已有账号</button>
      <slot name="notice" />
      <footer class="public-links" aria-label="海内公开信息">
        <a href="/about">关于海内</a>
        <a href="/privacy">隐私政策</a>
        <a href="/terms">服务条款</a>
      </footer>
    </section>
  </main>
</template>

<script setup lang="ts">
import LoginIllustration from "./LoginIllustration.vue";

const emit = defineEmits<{ start: []; "have-account": [] }>();
</script>

<style scoped>
.welcome {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 480px;
  min-height: 100dvh;
  margin: 0 auto;
  background: var(--hn-bg);
  color: var(--hn-text);
  font-family: var(--hn-font-sans);
}

.welcome-actions {
  display: grid;
  flex: 1 0 auto;
  align-content: end;
  gap: 12px;
  padding: 8px var(--hn-gutter) max(16px, env(safe-area-inset-bottom));
}

.tagline {
  margin: 0 0 12px;
  color: var(--hn-text-3);
  font-size: 14px;
  text-align: center;
}

.public-links {
  display: flex;
  justify-content: center;
  gap: 4px 18px;
  margin-top: 4px;
}

.public-links a {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  color: var(--hn-text-3);
  font-size: 12px;
  text-decoration: none;
}

.public-links a:hover { text-decoration: underline; }
</style>
