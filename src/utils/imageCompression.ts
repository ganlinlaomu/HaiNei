/**
 * 智能图片压缩工具
 *
 * 压缩策略：
 * 1. 目标大小：默认 200KB - 300KB
 * 2. 原图已不超过目标上限时直接返回原图（不放大、不重编码）
 * 3. 先把长边限制到 maxEdge（默认 2048px），避免在 1200 万像素画布上反复编码
 * 4. 之后每轮按“当前大小 / 目标大小”估算下一轮参数：
 *    - 只差一点时优先降质量（不低于 0.6）
 *    - 差得多时按面积比例直接缩小尺寸
 * 5. 通过 canvas 处理（createImageBitmap 已按 EXIF 方向解码）
 */

const MIN_TARGET_SIZE = 200 * 1024; // 200KB
const MAX_TARGET_SIZE = 300 * 1024; // 300KB
const MAX_ITERATIONS = 6; // 最大迭代次数
const DEFAULT_MAX_EDGE = 2048;
const MIN_EDGE = 480;
const START_QUALITY = 0.82;
const MIN_QUALITY = 0.6;

interface CompressionOptions {
  minTargetSize?: number;
  maxTargetSize?: number;
  maxIterations?: number;
  /** Longest edge of the first encode. */
  maxEdge?: number;
}

interface CompressionResult {
  file: File;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  iterations: number;
}

type CompressionStep = { quality: number; scale: number };

/**
 * Pick the next encode after one came out `size` bytes. JPEG size grows
 * roughly with pixel count, so a large miss is corrected by scaling the area
 * by target/size in one step instead of shaving 10% per round.
 */
export function nextCompressionStep(
  current: CompressionStep,
  size: number,
  targetSize: number,
  minScale: number,
): CompressionStep {
  const ratio = targetSize / size;
  if (ratio >= 0.7 && current.quality > MIN_QUALITY) {
    return { quality: Math.max(MIN_QUALITY, current.quality - 0.1), scale: current.scale };
  }
  const quality = Math.max(MIN_QUALITY, current.quality - 0.05);
  // A quality drop alone also shrinks the file; leave a little headroom.
  const scale = Math.max(minScale, current.scale * Math.min(0.92, Math.sqrt(ratio) * 1.05));
  return { quality, scale };
}

function unchanged(file: File, iterations = 0): CompressionResult {
  return { file, originalSize: file.size, compressedSize: file.size, compressionRatio: 1, iterations };
}

/**
 * 压缩图片到目标大小范围
 */
export async function compressImageToTargetSize(
  file: File,
  options: CompressionOptions = {}
): Promise<CompressionResult> {
  const minTargetSize = options.minTargetSize ?? MIN_TARGET_SIZE;
  const maxTargetSize = options.maxTargetSize ?? MAX_TARGET_SIZE;
  const maxIterations = Math.max(1, options.maxIterations ?? MAX_ITERATIONS);
  const maxEdge = Math.max(MIN_EDGE, options.maxEdge ?? DEFAULT_MAX_EDGE);
  const targetSize = (minTargetSize + maxTargetSize) / 2;
  const originalSize = file.size;

  if (!file.type.startsWith("image/")) return unchanged(file);
  // 原图已不超过目标上限：直接用原图
  if (originalSize <= maxTargetSize) return unchanged(file);

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    const minScale = Math.min(1, MIN_EDGE / longest);
    let step: CompressionStep = { quality: START_QUALITY, scale: Math.min(1, maxEdge / longest) };
    let best: Blob | null = null;
    let iteration = 0;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 Canvas 上下文");

    while (iteration < maxIterations) {
      iteration++;
      const targetWidth = Math.max(1, Math.round(width * step.scale));
      const targetHeight = Math.max(1, Math.round(height * step.scale));
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error("Canvas toBlob 失败")), "image/jpeg", step.quality);
      });

      // Every step encodes fewer bytes than the last, so the latest is best.
      best = blob;
      // In range, or already below it: stop. A too-small result is still the
      // best one available, re-encoding larger would only cost time.
      if (blob.size <= maxTargetSize) break;
      const next = nextCompressionStep(step, blob.size, targetSize, minScale);
      if (next.quality === step.quality && next.scale === step.scale) break;
      step = next;
    }

    if (!best) throw new Error("压缩失败");
    if (best.size >= originalSize) return unchanged(file, iteration);
    const compressedFile = new File([best], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
    return {
      file: compressedFile,
      originalSize,
      compressedSize: best.size,
      compressionRatio: best.size / originalSize,
      iterations: iteration,
    };
  } catch (error) {
    console.error("图片压缩失败，返回原图:", error);
    return unchanged(file);
  } finally {
    bitmap?.close();
  }
}

/**
 * 批量压缩图片
 */
export async function compressImages(
  files: File[],
  options: CompressionOptions = {}
): Promise<CompressionResult[]> {
  const results: CompressionResult[] = [];
  
  for (const file of files) {
    const result = await compressImageToTargetSize(file, options);
    results.push(result);
  }
  
  return results;
}
