/** Fetch only public Aozora XHTML. Fail over to Aozora's official renewal site
 * when the original site's DNS/origin is unavailable to Cloudflare.
 * Never redirect to a user-supplied host or path.
 */
const LIMIT = 5 * 1024 * 1024;
const OFFICIAL_HOST = "www.aozora.gr.jp";
const RENEWAL_HOST = "www.aozora-renewal.cloud";
const HOSTS = new Set([OFFICIAL_HOST, RENEWAL_HOST, "aozora-renewal.cloud"]);
const HTML_PATH = /^\/cards\/\d{6}\/files\/\d+_[\w-]+\.html$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function accepted(url: URL, originalPath: string, officialOnly = false): boolean {
  return url.protocol === "https:" &&
    (officialOnly ? url.hostname === OFFICIAL_HOST : HOSTS.has(url.hostname)) &&
    !url.port && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === originalPath &&
    HTML_PATH.test(url.pathname);
}

/** A null result means this origin failed: try the next trusted Aozora host. */
async function downloadFrom(origin: string, path: string): Promise<Response | null> {
  let target = new URL(path, origin);
  for (let hop = 0; hop <= 2; hop++) {
    if (!accepted(target, path)) return null;
    try {
      const response = await fetch(target.href, {
        redirect: "manual",
        headers: { Accept: "text/html,application/xhtml+xml;q=0.9" },
        signal: AbortSignal.timeout(12_000),
      });
      if (REDIRECTS.has(response.status)) {
        const location = response.headers.get("Location");
        if (!location) return null;
        const next = new URL(location, target);
        if (!accepted(next, path)) return null;
        target = next;
        continue;
      }
      if (!response.ok) return null;
      const announced = Number(response.headers.get("Content-Length") || 0);
      if (announced > LIMIT) return new Response("Aozora text exceeds limit", { status: 413 });
      const mediaType = response.headers.get("Content-Type") || "";
      if (mediaType && !/^(text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(mediaType)) return null;

      // Content-Length may be absent or refer to compressed bytes. Bound the
      // decoded stream too so an upstream response cannot exhaust memory.
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > LIMIT) {
            await reader.cancel().catch(() => {});
            return new Response("Aozora text exceeds limit", { status: 413 });
          }
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      }
      if (total < 50) return null;
      const bytes = new Uint8Array(total);
      let pos = 0;
      for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.byteLength; }
      // Official Aozora XHTML is Shift-JIS encoded, on both site versions.
      const html = new TextDecoder("shift_jis").decode(bytes);
      if (!/<(?:html|body)\b/i.test(html) || !/[<>]/.test(html)) return null;
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return null;
    }
  }
  return null;
}

export async function onRequestGet(context: { request: Request }): Promise<Response> {
  const input = new URL(context.request.url).searchParams.get("url") || "";
  let source: URL;
  try {
    if (input.length > 400) throw Error("URL too long");
    source = new URL(input);
    if (!accepted(source, source.pathname, true)) throw Error("Invalid source");
  } catch {
    return new Response("Invalid Aozora book URL", { status: 400 });
  }
  for (const origin of ["https://" + OFFICIAL_HOST, "https://" + RENEWAL_HOST]) {
    const response = await downloadFrom(origin, source.pathname);
    if (response) return response;
  }
  return new Response("Aozora original and renewal sites are both unavailable", {
    status: 502,
    headers: { "Cache-Control": "no-store" },
  });
}
