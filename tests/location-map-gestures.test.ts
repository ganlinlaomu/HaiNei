import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { applyGesture, project, settleGesture, unproject, MAX_MAP_ZOOM } from "@/utils/mapTiles";
import { useMapGestures } from "@/composables/useMapGestures";

const SHANGHAI = { lat: 31.2304, lng: 121.4737 };
const W = 400, H = 600;

describe("map gesture math", () => {
  it("unproject inverts project", () => {
    const back = unproject(project(SHANGHAI, 15), 15);
    expect(back.lat).toBeCloseTo(SHANGHAI.lat, 6);
    expect(back.lng).toBeCloseTo(SHANGHAI.lng, 6);
  });

  it("a drag moves the centre the opposite way; a pinch about the centre only zooms", () => {
    const center = project(SHANGHAI, 15);
    const view = { center, zoom: 15, width: W, height: H };
    const drag = settleGesture(view, { scale: 1, originX: 0, originY: 0, dx: 100, dy: 0 });
    expect(drag.zoom).toBe(15);
    expect(project(drag.focus, 15).x).toBeCloseTo(center.x - 100, 4);
    const pinch = settleGesture(view, { scale: 2.1, originX: W / 2, originY: H / 2, dx: 0, dy: 0 });
    expect(pinch.zoom).toBe(16);
    expect(project(pinch.focus, 15).x).toBeCloseTo(center.x, 4);
  });

  it("zooming about a corner keeps that corner's place on the map under the fingers", () => {
    const center = project(SHANGHAI, 15);
    const settled = settleGesture({ center, zoom: 15, width: W, height: H }, { scale: 2, originX: 0, originY: 0, dx: 0, dy: 0 });
    // The new centre is what was a quarter of the way in from the corner.
    expect(project(settled.focus, 15).x).toBeCloseTo(center.x - W / 4, 4);
    expect(project(settled.focus, 15).y).toBeCloseTo(center.y - H / 4, 4);
    expect(applyGesture({ left: 10, top: 20 }, { scale: 2, originX: 0, originY: 0, dx: 5, dy: 0 })).toEqual({ left: 25, top: 40 });
  });
});

function setup(zoom = 15) {
  let time = 1_000;
  const settle = vi.fn();
  const element = ref({ getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture: vi.fn() } as any);
  const api = useMapGestures({
    element, settle, now: () => time,
    view: () => ({ center: project(SHANGHAI, zoom), zoom, width: W, height: H }),
  });
  const event = (pointerId: number, x: number, y: number) => ({ pointerId, clientX: x, clientY: y, target: null }) as any;
  return { api, settle, event, tick: (ms: number) => { time += ms; } };
}

describe("map gestures", () => {
  it("one finger drags the map and settles on release", () => {
    const { api, settle, event } = setup();
    api.onPointerDown(event(1, 100, 100));
    api.onPointerMove(event(1, 160, 100));
    expect(api.gesture.value).toMatchObject({ scale: 1, dx: 60, dy: 0 });
    api.onPointerEnd(event(1, 160, 100));
    expect(api.gesture.value).toBeNull();
    expect(settle).toHaveBeenCalledWith(15, expect.anything());
  });

  it("two fingers pinch-zoom, snapping to whole levels", () => {
    const { api, settle, event } = setup();
    api.onPointerDown(event(1, 150, 300));
    api.onPointerDown(event(2, 250, 300));
    api.onPointerMove(event(1, 100, 300));
    api.onPointerMove(event(2, 300, 300));
    expect(api.gesture.value?.scale).toBeCloseTo(2);
    api.onPointerEnd(event(2, 300, 300));
    expect(settle).toHaveBeenLastCalledWith(16, expect.anything());
    api.onPointerEnd(event(1, 100, 300));
  });

  it("double tap zooms in one level; a single tap does nothing", () => {
    const { api, settle, event, tick } = setup();
    api.onPointerDown(event(1, 200, 300)); tick(80); api.onPointerEnd(event(1, 200, 300));
    expect(settle).not.toHaveBeenCalled();
    tick(150);
    api.onPointerDown(event(1, 202, 301)); tick(80); api.onPointerEnd(event(1, 202, 301));
    expect(settle).toHaveBeenCalledWith(16, expect.anything());
  });

  it("wheel steps one level, rate-limited, never past the maximum", () => {
    const { api, settle, tick } = setup();
    api.onWheel({ deltaY: -10, offsetX: 200, offsetY: 300 } as any);
    api.onWheel({ deltaY: -10, offsetX: 200, offsetY: 300 } as any);
    expect(settle).toHaveBeenCalledTimes(1);
    tick(300);
    api.onWheel({ deltaY: 10, offsetX: 200, offsetY: 300 } as any);
    expect(settle).toHaveBeenLastCalledWith(14, expect.anything());
    const max = setup(MAX_MAP_ZOOM);
    max.api.onWheel({ deltaY: -10, offsetX: 0, offsetY: 0 } as any);
    expect(max.settle).not.toHaveBeenCalled();
  });

  it("the full-screen map wires the gestures and ⌖ returns to framing everyone", () => {
    const sheet = readFileSync("src/components/LocationMapSheet.vue", "utf8");
    expect(sheet).toContain('@pointerdown="onPointerDown"');
    expect(sheet).toContain('@wheel.prevent="onWheel"');
    expect(sheet).toContain('class="location-map-layer" :style="layerStyle"');
    expect(sheet).toMatch(/function resetView\(\) \{\s*manualZoom\.value = null;\s*manualFocus\.value = null;/);
    expect(sheet).toMatch(/\.location-map\{[^}]*touch-action:none/);
  });
});
