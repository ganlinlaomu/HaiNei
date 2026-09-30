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
import { onAppResume } from '@/services/appResumeCoordinator';

const showUpdate = ref(false);
const updating = ref(false);
let registration: ServiceWorkerRegistration | null = null;
let updateInFlight: Promise<void> | null = null;
let reloadedForControllerChange = false;
let initialCheckTimer: number | null = null;
let updateInterval: number | null = null;
let stopAppResume: (() => void) | null = null;
let expectedBuildId = "";
const PENDING_BUILD_KEY = "hainei_pending_build_id";
const BUILD_QUERY_KEY = "_hainei_build";

type BuildInfo = { type: "BUILD_INFO"; version: string; buildId: string };

function requestBuildInfo(worker: ServiceWorker | null, timeoutMs = 1500): Promise<BuildInfo | null> {
  if (!worker) return Promise.resolve(null);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => {
      channel.port1.onmessage = null;
      resolve(null);
    }, timeoutMs);
    channel.port1.onmessage = event => {
      window.clearTimeout(timer);
      const data = event.data as Partial<BuildInfo> | undefined;
      resolve(data?.type === "BUILD_INFO" && typeof data.buildId === "string"
        ? data as BuildInfo
        : null);
    };
    worker.postMessage({ type: "GET_BUILD_INFO" }, [channel.port2]);
  });
}

async function waitForControllerBuild(buildId: string, timeoutMs = 4000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const info = await requestBuildInfo(navigator.serviceWorker.controller, 500);
    if (info?.buildId === buildId) return true;
    await new Promise(resolve => window.setTimeout(resolve, 100));
  }
  return false;
}

function reloadForBuild(buildId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(BUILD_QUERY_KEY, buildId);
  window.location.replace(url.toString());
}

async function verifyReloadedBuild() {
  const pendingBuildId = sessionStorage.getItem(PENDING_BUILD_KEY) || "";
  if (!pendingBuildId) return;

  const info = await requestBuildInfo(navigator.serviceWorker.controller);
  if (info?.buildId !== pendingBuildId) {
    console.warn("[PWA] 页面仍未由目标版本控制", {
      expected: pendingBuildId,
      actual: info?.buildId || null
    });
    showUpdate.value = true;
    return;
  }

  sessionStorage.removeItem(PENDING_BUILD_KEY);
  const url = new URL(window.location.href);
  if (url.searchParams.has(BUILD_QUERY_KEY)) {
    url.searchParams.delete(BUILD_QUERY_KEY);
    window.history.replaceState(window.history.state, "", url.toString());
  }
  console.log("[PWA] 已确认运行目标版本", pendingBuildId);
}

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
    await checkForUpdate();
    if (!registration?.waiting) {
      updating.value = false;
      return;
    }
  }

  updating.value = true;
  const waitingWorker = registration.waiting;
  const buildInfo = await requestBuildInfo(waitingWorker);
  expectedBuildId = buildInfo?.buildId || "";

  if (expectedBuildId) {
    sessionStorage.setItem(PENDING_BUILD_KEY, expectedBuildId);
    console.log("[PWA] 准备切换到版本", expectedBuildId);
  } else {
    console.warn("[PWA] 无法读取等待版本 BUILD_ID，将使用兼容刷新流程");
  }

  waitingWorker.postMessage({ type: "SKIP_WAITING" });
};

const handleControllerChange = async () => {
  if (reloadedForControllerChange) return;
  reloadedForControllerChange = true;

  const targetBuildId = expectedBuildId || sessionStorage.getItem(PENDING_BUILD_KEY) || "";
  if (targetBuildId) {
    const confirmed = await waitForControllerBuild(targetBuildId);
    if (confirmed) {
      console.log("[PWA] 新 Service Worker 已接管", targetBuildId);
      reloadForBuild(targetBuildId);
      return;
    }
    console.warn("[PWA] 新控制器 BUILD_ID 未能确认，执行兼容刷新", targetBuildId);
  }

  window.location.reload();
};

onMounted(() => {
  if (!('serviceWorker' in navigator)) return;

  void verifyReloadedBuild();

  // 延迟检查，避免抢占首屏资源
  initialCheckTimer = window.setTimeout(() => void checkForUpdate(), 1000);

  stopAppResume = onAppResume(() => checkForUpdate());

  navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

  // 定时检查（开发环境可缩短至 1 分钟以便测试）
  updateInterval = window.setInterval(() => void checkForUpdate(), 5 * 60 * 1000);
});

onUnmounted(() => {
  if (updateInterval !== null) window.clearInterval(updateInterval);
  if (initialCheckTimer !== null) window.clearTimeout(initialCheckTimer);
  stopAppResume?.();
  stopAppResume = null;
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
