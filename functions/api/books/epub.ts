/** Narrow Gutenberg EPUB gateway for browser CORS. Not a general URL proxy. */
const MAX_BYTES = 25 * 1024 * 1024;
function accepted(url: URL): boolean {
  return url.protocol === "https:" &&
    (url.hostname === "www.gutenberg.org" || url.hostname === "gutenberg.org") &&
    !url.username && !url.password && !url.port &&
    (url.pathname.startsWith("/ebooks/") || url.pathname.startsWith("/cache/epub/")) &&
    /\.epub(?:3)?(?:\.|$)/i.test(url.pathname);
}
export async function onRequestGet(context: { request: Request }): Promise<Response> {
  const requestUrl = new URL(context.request.url);
  const original = requestUrl.searchParams.get("url");
  if (!original || original.length > 500) return new Response("Invalid Gutenberg URL", { status: 400 });
  let target: URL;
  try {
    target = new URL(original);
    if (!accepted(target)) return new Response("Unsupported download URL", { status: 400 });
  } catch { return new Response("Invalid URL", { status: 400 }); }
  try {
    for (let redirect = 0; redirect < 4; redirect++) {
      const response = await fetch(target.href, {
        method: "GET",
        redirect: "manual",
        headers: { "Accept": "application/epub+zip,application/octet-stream;q=0.9" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location");
        if (!location) return new Response("Missing upstream redirect", { status: 502 });
        const next = new URL(location, target);
        if (!accepted(next)) return new Response("Unsupported upstream redirect", { status: 502 });
        target = next;
        continue;
      }
      if (!response.ok) return new Response("Gutenberg returned HTTP " + response.status, { status: 502 });
      const announced = Number(response.headers.get("Content-Length") || 0);
      if (announced > MAX_BYTES) return new Response("Book exceeds the 25 MB limit", { status: 413 });
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (!reader) return new Response("Empty EPUB response", { status: 502 });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          return new Response("Book exceeds the 25 MB limit", { status: 413 });
        }
        chunks.push(value);
      }
      if (total < 100) return new Response("Empty EPUB response", { status: 502 });
      const data = new Uint8Array(total);
      let pos = 0;
      for (const chunk of chunks) { data.set(chunk, pos); pos += chunk.byteLength; }
      if (data[0] !== 0x50 || data[1] !== 0x4b) return new Response("Not an EPUB archive", { status: 502 });
      return new Response(data, {
        headers: {
          "Content-Type": "application/epub+zip",
          "Content-Length": String(total),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return new Response("Too many upstream redirects", { status: 502 });
  } catch {
    return new Response("Gutenberg download is currently unavailable", { status: 502 });
  }
}
