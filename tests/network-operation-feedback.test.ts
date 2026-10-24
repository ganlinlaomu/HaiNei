import { describe, expect, it } from "vitest";
import { dmDeliveryLabel, privateSyncFeedback } from "@/utils/networkOperationFeedback";

describe("network-only operation feedback", () => {
  it("distinguishes queued, uploading, failed, accepted, delivered and read private messages", () => {
    expect(dmDeliveryLabel("uploading")).toBe("上传中…");
    expect(dmDeliveryLabel("sending")).toBe("发送中…");
    expect(dmDeliveryLabel("uploading", true)).toBe("等待联网");
    expect(dmDeliveryLabel("sending", true)).toBe("等待联网");
    expect(dmDeliveryLabel("upload_failed")).toBe("上传失败");
    expect(dmDeliveryLabel("send_failed")).toBe("发送失败");
    expect(dmDeliveryLabel("sent")).toContain("Relay 已接受");
    expect(dmDeliveryLabel("delivered")).toContain("已送达");
    expect(dmDeliveryLabel("read")).toContain("已读");
  });

  it("offers retry only after a real cloud sync failure, never for local saves or offline", () => {
    expect(privateSyncFeedback("local")).toEqual({
      label: "已保存在本机 · 等待云端同步", retryable: false,
    });
    expect(privateSyncFeedback("syncing")).toEqual({
      label: "正在加密同步到云端…", retryable: false,
    });
    expect(privateSyncFeedback("synced").retryable).toBe(false);
    expect(privateSyncFeedback("offline")).toEqual({
      label: "当前离线 · 修改已保存在本机", retryable: false,
    });
    expect(privateSyncFeedback("error")).toEqual({
      label: "云同步失败 · 修改仍保存在本机", retryable: true,
    });
    expect(privateSyncFeedback("unavailable").retryable).toBe(false);
  });
});
