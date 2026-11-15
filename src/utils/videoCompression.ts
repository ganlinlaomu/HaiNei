import { debugLog } from "@/utils/debugLog";

/** Longest output side: 720p keeps faces and text readable at chat size. */
const MAX_SIDE = 1280;
const VIDEO_BITRATE = 1_500_000;
/** Already this lean and small: re-encoding would only cost time and battery. */
const SKIP_BITRATE = 2_000_000;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/**
 * Re-encode a picked video (DM or post) to H.264/AAC MP4 at most 1280px on its longest side.
 * Returns the original when the device cannot encode (no WebCodecs), when the
 * video is already small enough, or when re-encoding would not make it smaller.
 */
export async function compressVideoForUpload(
  file: File,
  options: { signal?: AbortSignal; onProgress?: (progress: number) => void } = {},
): Promise<File> {
  const { signal, onProgress } = options;
  if (typeof VideoEncoder === "undefined") return file;
  const startedAt = Date.now();
  const {
    Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat, ALL_FORMATS, canEncodeVideo,
  } = await import("mediabunny");
  if (!(await canEncodeVideo("avc", { width: MAX_SIDE, height: 720, bitrate: VIDEO_BITRATE }).catch(() => false))) return file;

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return file;
    const duration = await input.computeDuration();
    const longest = Math.max(track.displayWidth, track.displayHeight);
    const sourceBitrate = duration > 0 ? (file.size * 8) / duration : Infinity;
    if (longest <= MAX_SIDE && sourceBitrate <= SKIP_BITRATE) return file;

    const scale = Math.min(1, MAX_SIDE / longest);
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { width: even(track.displayWidth * scale), codec: "avc", bitrate: VIDEO_BITRATE },
      // AAC from a phone camera is copied as-is; anything else needs an AAC
      // encoder, which some browsers lack.
      audio: { codec: "aac" },
      showWarnings: false,
    });
    // Never trade the sound (or the picture) for a smaller file.
    if (!conversion.isValid || conversion.discardedTracks.length) return file;
    if (onProgress) conversion.onProgress = progress => onProgress(Math.min(1, Math.max(0, progress)));
    const abort = () => { void conversion.cancel(); };
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await conversion.execute();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    const buffer = output.target.buffer;
    if (!buffer || buffer.byteLength >= file.size) return file;
    debugLog("media", "dm_video_compressed", {
      fromBytes: file.size, toBytes: buffer.byteLength, longest, durationMs: Date.now() - startedAt,
    }, "info");
    return new File([buffer], file.name.replace(/\.[^.]*$/, "") + ".mp4", { type: "video/mp4" });
  } finally {
    input.dispose();
  }
}
