/**
 * Version Manager - Handles app version tracking and update detection
 * 修改说明：移除自动清空数据的逻辑，仅更新版本号标记
 */

import { APP_VERSION } from "@/db/dexie";
import { deviceStorage } from "@/services/deviceStorage";

const VERSION_KEY = "app_version";
const LAST_UPDATE_CHECK_KEY = "last_update_check";

/**
 * 获取本地存储的版本号
 */
export function getStoredVersion(): string | null {
  try {
    return deviceStorage.getItem(VERSION_KEY);
  } catch (e) {
    console.error("[VersionManager] Failed to get stored version", e);
    return null;
  }
}

/**
 * 在本地更新当前版本号记录
 */
export function storeCurrentVersion(): void {
  try {
    deviceStorage.setItem(VERSION_KEY, APP_VERSION);
    deviceStorage.setItem(LAST_UPDATE_CHECK_KEY, Date.now().toString());
  } catch (e) {
    console.error("[VersionManager] Failed to store version", e);
  }
}

/**
 * 检查版本是否发生变化
 */
export function hasVersionChanged(): boolean {
  const stored = getStoredVersion();
  
  if (!stored) {
    return false;
  }
  
  if (stored !== APP_VERSION) {
    console.log(`[VersionManager] Version changed from ${stored} to ${APP_VERSION}`);
    return true;
  }
  
  return false;
}

/**
 * 处理版本更新逻辑
 * 修改点：移除了 clearAllAppData()，确保更新时不掉号
 */
export async function handleVersionUpdate(): Promise<void> {
  console.log("[VersionManager] Updating version markers...");
  
  try {
    // 💡 关键改动：不再执行 clearAllAppData()
    // 仅仅更新版本记录，保持本地数据（Nostr 私钥、好友列表等）完好无损
    storeCurrentVersion();
    console.log("[VersionManager] Version update handled safely (data preserved)");
  } catch (e) {
    console.error("[VersionManager] Error handling version update", e);
    throw e;
  }
}

/**
 * 初始化版本追踪
 */
export function initVersionTracking(): boolean {
  const versionChanged = hasVersionChanged();
  
  if (!versionChanged) {
    storeCurrentVersion();
    return false;
  }
  
  return true;
}

/**
 * (保留备份) 强制清理所有应用数据
 * 仅在极端故障情况下手动调用，不再自动触发
 */
export async function clearAllAppData(): Promise<void> {
  console.warn("[VersionManager] Manual clearAllAppData requested");
  
  try {
    const keysToKeep = [VERSION_KEY, LAST_UPDATE_CHECK_KEY];
    Array.from({ length: deviceStorage.length }, (_, index) => deviceStorage.key(index)).filter((key): key is string => !!key).forEach(key => {
      if (!keysToKeep.includes(key)) deviceStorage.removeItem(key);
    });
    sessionStorage.clear();
    
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }

    if ('indexedDB' in window) {
      // 这里的删除逻辑保持不变，但目前不会被 handleVersionUpdate 调用
      const dbName = "closed_community_db";
      await new Promise<void>((resolve) => {
        const req = window.indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
  } catch (e) {
    console.error("[VersionManager] Cleanup failed", e);
  }
}
