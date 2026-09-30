export async function timedJsonFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}
