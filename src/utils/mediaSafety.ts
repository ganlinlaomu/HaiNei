const MIME =
  /^(?:image\/(?:jpeg|png|webp|gif|avif)|video\/(?:mp4|webm|quicktime)|audio\/(?:webm|mp4|mpeg|ogg|wav|x-m4a))(?:;\s*codecs=[a-zA-Z0-9.,\s"'-]+)?$/;
export function hasOnlyObjectKeys(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.every(key => allowed.includes(key));
}

export function safeMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}
export function validEncryptedMedia(value: unknown): boolean {
  const item = value as any;
  if (
    !item ||
    !safeMediaUrl(item.url) ||
    typeof item.mime !== "string" ||
    item.mime.length > 120 ||
    !MIME.test(item.mime) ||
    item.alg !== "AES-GCM"
  )
    return false;
  try {
    if (
      typeof item.key !== "string" ||
      typeof item.iv !== "string" ||
      item.key.length > 48 ||
      item.iv.length > 20 ||
      atob(item.key).length !== 32 ||
      atob(item.iv).length !== 12
    )
      return false;
  } catch {
    return false;
  }
  for (const name of ["width", "height"])
    if (
      item[name] !== undefined &&
      (!Number.isInteger(item[name]) || item[name] <= 0 || item[name] > 16384)
    )
      return false;
  if (
    item.size !== undefined &&
    (!Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      item.size > 1024 * 1024 * 1024)
  )
    return false;
  if (
    item.duration !== undefined &&
    (!Number.isFinite(item.duration) ||
      item.duration < 0 ||
      item.duration > 86400)
  )
    return false;
  return true;
}
function mediaDownloadError(name: "AbortError" | "TimeoutError", message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

export async function downloadMedia(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!safeMediaUrl(url)) throw new Error("invalid_media_url");
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (signal?.aborted) abortFromCaller();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, 20_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok || !response.body) throw new Error("media_download_failed");
    if (Number(response.headers.get("Content-Length")) > maxBytes) {
      controller.abort();
      throw new Error("media_too_large");
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("media_too_large");
      }
      chunks.push(part.value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes.buffer;
  } catch (error) {
    if (timedOut) throw mediaDownloadError("TimeoutError", "media_download_timeout");
    if (signal?.aborted) throw mediaDownloadError("AbortError", "media_download_aborted");
    throw error;
  } finally {
    reader?.releaseLock();
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
