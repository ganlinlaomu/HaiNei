import type { LocationShare } from "@/nostr/messaging/locationShare";

const LOCATION_TIMEOUT_MS = 15_000;

/** A user-facing reason the device location could not be read. */
export class LocationUnavailableError extends Error {}

/** Reads the device location once (high accuracy), or explains why it cannot. */
export function getCurrentLocation(options: { timeoutMs?: number; geolocation?: Geolocation | undefined } = {}): Promise<LocationShare> {
  const geolocation = "geolocation" in options
    ? options.geolocation
    : typeof navigator === "undefined" ? undefined : navigator.geolocation;
  if (!geolocation) return Promise.reject(new LocationUnavailableError("当前设备或浏览器不支持定位"));
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      position => resolve({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : undefined,
        at: Math.floor((position.timestamp || Date.now()) / 1000),
      }),
      error => {
        const message = error.code === 1
          ? "未允许使用位置：请在系统设置中允许海内访问位置"
          : error.code === 3
            ? "获取位置超时，请到开阔处或开启 Wi‑Fi 后重试"
            : "暂时无法获取位置，请稍后重试";
        reject(new LocationUnavailableError(message));
      },
      { enableHighAccuracy: true, timeout: options.timeoutMs ?? LOCATION_TIMEOUT_MS, maximumAge: 30_000 },
    );
  });
}
