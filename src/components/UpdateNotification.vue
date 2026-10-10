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
let watchedRegistration: ServiceWorkerRegistration | null = null;
let watchedInstalling: ServiceWorker | null = null;
const PENDING_BUILD_KEY = "hainei_pending_build_id";
const BUILD_QUERY_KEY = "_hainei_build";

type BuildInfo = { type: "BUILD_INFO"; version: string; buildId: string };

function requestBuildInfo(worker: ServiceWorker | null, timeoutMs = 1500): Promise<BuildInfo | null> {
  if (!worker) return Promise.resolve(null);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => {
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(null);
    }, timeoutMs);
    channel.port1.onmessage = event => {
      window.clearTimeout(timer);
      const data = event.data as Partial<BuildInfo> | undefined;
      channel.port1.close();
      resolve(data?.type === "BUILD_INFO" && typeof data.buildId === "string"
        ? data as BuildInfo
        : null);
    };
    try {
      worker.postMessage({ type: "GET_BUILD_INFO" }, [channel.port2]);
    } catch {
      window.clearTimeout(timer);
      channel.port1.close();
      resolve(null);
    }
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
    // A stale controller is not proof that another update is waiting.
    // Do not keep re-opening a banner that has already been acted on.
    void checkForUpdate();
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

function detachWorkerListeners() {
  watchedRegistration?.removeEventListener('updatefound', handleUpdateFound);
  watchedInstalling?.removeEventListener('statechange', handleInstallingStateChange);
  watchedRegistration = null;
  watchedInstalling = null;
}

function handleInstallingStateChange() {
  if (watchedInstalling?.state === 'installed') {
    void refreshWaitingUpdate();
  }
}

function handleUpdateFound() {
  const worker = watchedRegistration?.installing;
  if (!worker || worker === watchedInstalling) return;
  watchedInstalling?.removeEventListener('statechange', handleInstallingStateChange);
  watchedInstalling = worker;
  worker.addEventListener('statechange', handleInstallingStateChange);
  handleInstallingStateChange();
}

// Show a banner only for a real waiting worker with a different build ID.
// Repeated checks and same-commit redeploys must not re-open the prompt.
async function refreshWaitingUpdate() {
  if (updating.value || reloadedForControllerChange) return;
  const waitingWorker = registration?.waiting;
  const activeWorker = navigator.serviceWorker.controller;
  if (!waitingWorker || !activeWorker) {
    showUpdate.value = false;
    return;
  }
  const [next, current] = await Promise.all([
    requestBuildInfo(waitingWorker),
    requestBuildInfo(activeWorker),
  ]);
  if (waitingWorker !== registration?.waiting || updating.value || reloadedForControllerChange) return;
  const sameBuild = !!next?.buildId && !!current?.buildId && next.buildId === current.buildId;
  // A pending handoff already acknowledged by this tab must not present the
  // same "立即更新" again merely because the app resumed or reloaded.
  const alreadyApplying = !!next?.buildId && sessionStorage.getItem(PENDING_BUILD_KEY) === next.buildId;
  showUpdate.value = !sameBuild && !alreadyApplying;
}

const performUpdateCheck = async () => {
  const nextRegistration = await navigator.serviceWorker.getRegistration();
  if (registration !== nextRegistration) {
    detachWorkerListeners();
    registration = nextRegistration || null;
  }
  if (!registration) {
    showUpdate.value = false;
    return;
  }
  if (watchedRegistration !== registration) {
    watchedRegistration = registration;
    registration.addEventListener('updatefound', handleUpdateFound);
    handleUpdateFound();
  }
  await refreshWaitingUpdate();
  try {
    await registration.update();
  } catch (e) {
    console.error('[PWA] 主动检查更新失败:', e);
  }
  await refreshWaitingUpdate();
};

/**
 * 立即更新
 */
const updateApp = async () => {
  if (updating.value) return;
  if (!registration?.waiting) await checkForUpdate();
  const waitingWorker = registration?.waiting;
  if (!waitingWorker || !navigator.serviceWorker.controller) {
    showUpdate.value = false;
    return;
  }
  updating.value = true;
  try {
    const [next, current] = await Promise.all([
      requestBuildInfo(waitingWorker),
      requestBuildInfo(navigator.serviceWorker.controller),
    ]);
    if (registration?.waiting !== waitingWorker) {
      updating.value = false;
      await refreshWaitingUpdate();
      return;
    }
    if (next?.buildId && current?.buildId && next.buildId === current.buildId) {
      updating.value = false;
      showUpdate.value = false;
      return;
    }

    expectedBuildId = next?.buildId || "";
    if (expectedBuildId) {
      sessionStorage.setItem(PENDING_BUILD_KEY, expectedBuildId);
      console.log("[PWA] 准备切换到版本", expectedBuildId);
    } else {
      console.warn("[PWA] 无法读取等待版本 BUILD_ID，将使用兼容刷新流程");
    }
    showUpdate.value = false;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  } catch (error) {
    console.warn("[PWA] 无法启动更新", error);
    if (expectedBuildId) sessionStorage.removeItem(PENDING_BUILD_KEY);
    expectedBuildId = "";
    updating.value = false;
    await refreshWaitingUpdate();
  }
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
  detachWorkerListeners();
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
