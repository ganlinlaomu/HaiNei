/** Web Mercator tile math for the location map (256 px OSM tiles). */
export const TILE_SIZE = 256;
export const MIN_MAP_ZOOM = 3;
export const MAX_MAP_ZOOM = 17;
const MAX_LATITUDE = 85.05112878;

export type MapPoint = { lat: number; lng: number };
export type PixelPoint = { x: number; y: number };

/** World pixel coordinates of a point at `zoom`. */
export function project(point: MapPoint, zoom: number): PixelPoint {
  const scale = TILE_SIZE * 2 ** zoom;
  const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, point.lat)) * Math.PI / 180;
  return {
    x: (point.lng + 180) / 360 * scale,
    y: (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * scale,
  };
}

/** The largest zoom (up to the default) that shows every point with padding. */
export function fitZoom(points: MapPoint[], width: number, height: number, padding = 56, preferred = 16) {
  if (points.length < 2) return preferred;
  for (let zoom = Math.min(preferred, MAX_MAP_ZOOM); zoom > MIN_MAP_ZOOM; zoom--) {
    const pixels = points.map(point => project(point, zoom));
    const spanX = Math.max(...pixels.map(p => p.x)) - Math.min(...pixels.map(p => p.x));
    const spanY = Math.max(...pixels.map(p => p.y)) - Math.min(...pixels.map(p => p.y));
    if (spanX <= width - 2 * padding && spanY <= height - 2 * padding) return zoom;
  }
  return MIN_MAP_ZOOM;
}

/** The point halfway between the points' extremes, in world pixels. */
export function centerOf(points: MapPoint[], zoom: number): PixelPoint {
  const pixels = points.map(point => project(point, zoom));
  return {
    x: (Math.min(...pixels.map(p => p.x)) + Math.max(...pixels.map(p => p.x))) / 2,
    y: (Math.min(...pixels.map(p => p.y)) + Math.max(...pixels.map(p => p.y))) / 2,
  };
}

export type MapTile = { key: string; z: number; x: number; y: number; left: number; top: number };

/** Tiles covering a width x height viewport centred on `center` (world pixels). */
export function tilesFor(center: PixelPoint, zoom: number, width: number, height: number): MapTile[] {
  const count = 2 ** zoom;
  const originX = center.x - width / 2;
  const originY = center.y - height / 2;
  const tiles: MapTile[] = [];
  for (let ty = Math.floor(originY / TILE_SIZE); ty <= Math.floor((originY + height) / TILE_SIZE); ty++) {
    if (ty < 0 || ty >= count) continue;
    for (let tx = Math.floor(originX / TILE_SIZE); tx <= Math.floor((originX + width) / TILE_SIZE); tx++) {
      const x = ((tx % count) + count) % count; // the world wraps horizontally
      tiles.push({ key: `${zoom}/${tx}/${ty}`, z: zoom, x, y: ty, left: tx * TILE_SIZE - originX, top: ty * TILE_SIZE - originY });
    }
  }
  return tiles;
}

/** Screen position of a point in the same viewport. */
export function toScreen(point: MapPoint, center: PixelPoint, zoom: number, width: number, height: number) {
  const pixel = project(point, zoom);
  return { left: pixel.x - center.x + width / 2, top: pixel.y - center.y + height / 2 };
}

export function tileUrl(base: string, tile: Pick<MapTile, "z" | "x" | "y">) {
  return `${base}/tiles/${tile.z}/${tile.x}/${tile.y}.png`;
}
