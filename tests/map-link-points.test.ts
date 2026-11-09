import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMapLinkPoints, mapLinkPoint } from "@/services/mapLinkPoints";

const SHORT = "https://maps.app.goo.gl/akkoLdQVouxV8ve17";

describe("mapLinkPoint", () => {
  beforeEach(() => clearMapLinkPoints());

  it("带坐标的链接直接解析，不联网", async () => {
    const fetchImpl = vi.fn();
    expect(await mapLinkPoint("https://www.google.com/maps/@35.68,139.76,15z", fetchImpl)).toEqual({ lat: 35.68, lng: 139.76 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("短链接问 Worker，同一链接只问一次", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ lat: 35.6874623, lng: 139.84663 }));
    expect(await mapLinkPoint(SHORT, fetchImpl as never)).toEqual({ lat: 35.6874623, lng: 139.84663 });
    expect(await mapLinkPoint(SHORT, fetchImpl as never)).toEqual({ lat: 35.6874623, lng: 139.84663 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain(`/api/map-link?u=${encodeURIComponent(SHORT)}`);
  });

  it("Worker 找不到就是 null；网络失败下次再试", async () => {
    expect(await mapLinkPoint(SHORT, (async () => Response.json({})) as never)).toBeNull();
    clearMapLinkPoints();
    const failing = vi.fn(async () => { throw new TypeError("offline"); });
    expect(await mapLinkPoint(SHORT, failing as never)).toBeNull();
    expect(await mapLinkPoint(SHORT, failing as never)).toBeNull();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("不是地图链接不联网", async () => {
    const fetchImpl = vi.fn();
    expect(await mapLinkPoint("https://example.com/maps", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
