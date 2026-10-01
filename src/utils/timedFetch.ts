function namedRequestError(name: "AbortError" | "TimeoutError", message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

export async function timedJsonFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const upstream = init.signal;
  let timedOut = false;
  let upstreamAborted = false;
  const abortFromUpstream = () => {
    upstreamAborted = true;
    if (!controller.signal.aborted) controller.abort();
  };
  if (upstream?.aborted) abortFromUpstream();
  upstream?.addEventListener("abort", abortFromUpstream, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    if (upstreamAborted || upstream?.aborted) {
      if (upstream?.reason instanceof Error) throw upstream.reason;
      throw namedRequestError("AbortError", "request_aborted");
    }
    // Preserve the historical timedJsonFetch error surface for callers that
    // already inspect the underlying aborted request. Media download timeout
    // classification is handled separately in mediaSafety.ts.
    if (timedOut) throw error;
    throw error;
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener("abort", abortFromUpstream);
  }
}
