import { ref, type Ref } from "vue";
import {
  MAX_MAP_ZOOM, MIN_MAP_ZOOM, settleGesture, type MapGesture, type MapPoint, type PixelPoint,
} from "@/utils/mapTiles";

type View = { center: PixelPoint; zoom: number; width: number; height: number };
type PointerLike = Pick<PointerEvent, "pointerId" | "clientX" | "clientY" | "target">;
type WheelLike = Pick<WheelEvent, "deltaY" | "offsetX" | "offsetY">;

/**
 * Map gestures with pointer events, so touch and mouse share one path: one
 * pointer drags, two pinch (zooming about their midpoint), a double tap or a
 * wheel step zooms one level. While moving, `gesture` transforms what is on
 * screen; on release the view settles to whole tile zoom levels.
 */
export function useMapGestures(options: {
  element: Ref<HTMLElement | null>;
  view: () => View;
  settle: (zoom: number, focus: MapPoint) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const gesture = ref<MapGesture | null>(null);
  const pointers = new Map<number, { x: number; y: number }>();
  let start: { x: number; y: number; distance: number; count: number } | null = null;
  let downAt = 0;
  let lastTap: { at: number; x: number; y: number } | null = null;
  let lastWheel = -Infinity;

  function commit(value = gesture.value) {
    gesture.value = null;
    if (!value || (value.scale === 1 && Math.abs(value.dx) < 1 && Math.abs(value.dy) < 1)) return;
    const settled = settleGesture(options.view(), value);
    options.settle(settled.zoom, settled.focus);
  }
  function local(event: PointerLike) {
    const rect = options.element.value?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }
  function snapshot() {
    const list = [...pointers.values()].slice(0, 2);
    if (!list.length) return null;
    return {
      x: list.reduce((sum, p) => sum + p.x, 0) / list.length,
      y: list.reduce((sum, p) => sum + p.y, 0) / list.length,
      distance: list.length === 2 ? Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y) : 0,
      count: list.length,
    };
  }
  /** A finger added or lifted: keep what was done so far and continue from here. */
  function restart() {
    commit();
    start = snapshot();
  }

  function onPointerDown(event: PointerLike) {
    if ((event.target as HTMLElement | null)?.closest?.("button, a")) return;
    options.element.value?.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, local(event));
    if (pointers.size === 1) downAt = now();
    restart();
  }
  function onPointerMove(event: PointerLike) {
    if (!pointers.has(event.pointerId) || !start) return;
    pointers.set(event.pointerId, local(event));
    const current = snapshot();
    if (!current || current.count !== start.count) return;
    const zoom = options.view().zoom;
    const scale = start.count === 2 && start.distance > 0
      ? Math.max(2 ** (MIN_MAP_ZOOM - zoom), Math.min(2 ** (MAX_MAP_ZOOM - zoom), current.distance / start.distance))
      : 1;
    gesture.value = { scale, originX: start.x, originY: start.y, dx: current.x - start.x, dy: current.y - start.y };
  }
  function onPointerEnd(event: PointerLike) {
    if (!pointers.has(event.pointerId)) return;
    const point = local(event);
    const tap = pointers.size === 1 && start?.count === 1
      && (!gesture.value || Math.hypot(gesture.value.dx, gesture.value.dy) < 10) && now() - downAt < 300;
    pointers.delete(event.pointerId);
    restart();
    if (!tap) return;
    const at = now();
    if (lastTap && at - lastTap.at < 350 && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < 30) {
      lastTap = null;
      if (options.view().zoom < MAX_MAP_ZOOM) commit({ scale: 2, originX: point.x, originY: point.y, dx: 0, dy: 0 });
    } else {
      lastTap = { at, ...point };
    }
  }
  /** One zoom level per wheel step (trackpads send bursts; take one per 250 ms). */
  function onWheel(event: WheelLike) {
    const at = now();
    if (at - lastWheel < 250 || !event.deltaY) return;
    lastWheel = at;
    const zoom = options.view().zoom;
    const scale = event.deltaY < 0 ? 2 : 0.5;
    if ((scale > 1 && zoom >= MAX_MAP_ZOOM) || (scale < 1 && zoom <= MIN_MAP_ZOOM)) return;
    commit({ scale, originX: event.offsetX, originY: event.offsetY, dx: 0, dy: 0 });
  }

  return { gesture, onPointerDown, onPointerMove, onPointerEnd, onWheel };
}
