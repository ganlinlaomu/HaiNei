<template>
  <div v-if="showUpdate" class="update-notification">
    <div class="update-content">
      <div class="update-icon">🔄</div>

      <div class="update-text">
        <h3>发现新版本</h3>
        <p>应用已有更新，刷新即可使用最新版本</p>
      </div>

      <button
        class="update-button"
        :disabled="updating"
        @click="updateApp"
      >
        {{ updating ? '更新中…' : '立即更新' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const showUpdate = ref(false);
const updating = ref(false);
let registration: ServiceWorkerRegistration | null = null;
let updateInFlight: Promise<void> | null = null;
let reloadedForControllerChange = false;
let initialCheckTimer: number | null = null;
let updateInterval: number | null = null;

/**
 * 核心检查逻辑：更灵敏地捕捉等待中的 SW
 */
const checkForUpdate = () => {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  if (updateInFlight) return updateInFlight;

  updateInFlight = performUpdateCheck()
    .catch(error => console.error('[PWA] 检查更新失败:', error))
    .finally(() => { updateInFlight = null; });
  return updateInFlight;
};

const performUpdateCheck = async () => {

  // 获取当前的注册状态
  registration = await navigator.serviceWorker.getRegistration();
  
  if (!registration) return;

  // 1. 如果已经有 waiting 的 SW，直接显示（这种情况通常发生在页面刷新后）
  if (registration.waiting) {
    console.log('[PWA] 发现已存在等待更新的 Service Worker');
    showUpdate.value = true;
    return;
  }

  // 2. 监听更新发现事件：当浏览器后台下载完新 SW 字节时触发
  registration.onupdatefound = () => {
    const installingWorker = registration?.installing;
    if (!installingWorker) return;

    installingWorker.onstatechange = () => {
      // 只有当新 SW 下载并安装完成 (installed) 时，才提示用户
      if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
        console.log('[PWA] 新版本安装完成，准备好提醒用户');
        showUpdate.value = true;
      }
    };
  };

  // 3. 主动向服务器请求 service-worker.js，检查是否有字节变化
  try {
    await registration.update();
  } catch (e) {
    console.error('[PWA] 主动检查更新失败:', e);
  }
};

/**
 * 立即更新
 */
const updateApp = async () => {
  if (!registration?.waiting) {
    // 兜底逻辑：如果没有 waiting 的，尝试重新检查一次
    await checkForUpdate();
    if (!registration?.waiting) {
      updating.value = false;
      return;
    }
  }

  updating.value = true;
  // 发送信号给 sw.js 执行 self.skipWaiting()
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
};

const handleControllerChange = () => {
  if (reloadedForControllerChange) return;
  reloadedForControllerChange = true;
  console.log('[PWA] 控制权移交成功，正在刷新应用...');
  window.location.reload();
};

const handleVisibilityChange = () => {
  if (document.visibilityState === 'visible') void checkForUpdate();
};

onMounted(() => {
  if (!('serviceWorker' in navigator)) return;

  // 延迟检查，避免抢占首屏资源
  initialCheckTimer = window.setTimeout(() => void checkForUpdate(), 1000);

  // 🚀 灵敏度增强 1: 当用户把 PWA 从后台切回前台（或点击窗口）时立刻检查
  window.addEventListener('focus', checkForUpdate);

  // 🚀 灵敏度增强 2: 监听网络状态回到在线时检查
  window.addEventListener('online', checkForUpdate);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

  // 定时检查（开发环境可缩短至 1 分钟以便测试）
  updateInterval = window.setInterval(() => void checkForUpdate(), 5 * 60 * 1000);
});

onUnmounted(() => {
  if (updateInterval !== null) window.clearInterval(updateInterval);
  if (initialCheckTimer !== null) window.clearTimeout(initialCheckTimer);
  window.removeEventListener('focus', checkForUpdate);
  window.removeEventListener('online', checkForUpdate);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  navigator.serviceWorker?.removeEventListener('controllerchange', handleControllerChange);
});
</script>

<style scoped>
.update-notification {
  position: fixed;
  inset: 0 0 auto 0;
  z-index: 9999;
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: #fff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  animation: slideDown 0.25s ease-out;
}

@keyframes slideDown {
  from {
    transform: translateY(-100%);
  }
  to {
    transform: translateY(0);
  }
}

.update-content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 14px 18px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.update-icon {
  font-size: 28px;
  animation: rotate 2s linear infinite;
}

@keyframes rotate {
  to {
    transform: rotate(360deg);
  }
}

.update-text {
  flex: 1;
}

.update-text h3 {
  margin: 0 0 2px;
  font-size: 15px;
  font-weight: 600;
}

.update-text p {
  margin: 0;
  font-size: 13px;
  opacity: 0.9;
}

.update-button {
  background: #fff;
  color: #667eea;
  border: none;
  border-radius: 8px;
  padding: 8px 20px;
  font-weight: 600;
  cursor: pointer;
}

.update-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
