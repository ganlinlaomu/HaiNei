import type { PrivateSpaceSyncStatus } from "@/services/privateSpaceSync";

export type DmDeliveryState = "uploading" | "sending" | "upload_failed" | "send_failed"
  | "sent" | "delivered" | "read";

/** View-only labels; the durable NIP-17 outgoing queue remains authoritative. */
export function dmDeliveryLabel(state: DmDeliveryState, waitingNetwork = false): string {
  switch (state) {
    case "uploading": return waitingNetwork ? "等待联网" : "上传中…";
    case "sending": return waitingNetwork ? "等待联网" : "发送中…";
    case "upload_failed": return "上传失败";
    case "send_failed": return "发送失败";
    case "sent": return "✓ Relay 已接受";
    case "delivered": return "✓✓ 已送达";
    case "read": return "✓✓ 已读";
  }
}

/** Cloud feedback is not a local-save spinner. */
export function privateSyncFeedback(status: PrivateSpaceSyncStatus) {
  switch (status) {
    case "syncing": return { label: "正在加密同步到云端…", retryable: false };
    case "synced": return { label: "已加密同步到云端", retryable: false };
    case "offline": return { label: "当前离线 · 修改已保存在本机", retryable: false };
    case "error": return { label: "云同步失败 · 修改仍保存在本机", retryable: true };
    case "unavailable": return { label: "当前登录方式不支持加密云同步", retryable: false };
    case "local": return { label: "已保存在本机 · 等待云端同步", retryable: false };
  }
}
