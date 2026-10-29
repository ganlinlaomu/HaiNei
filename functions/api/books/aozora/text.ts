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
const MIRROR_PREFIX = "https://raw.githubusercontent.com/aozorahack/aozorabunko_text/master";
const RESPONSE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

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

function validMirror(value: string, person: string, work: string): URL | null {
  try {
    if (!value || value.length > 500) return null;
    const url = new URL(value);
    const match = /^\/aozorahack\/aozorabunko_text\/master\/cards\/(\d{6})\/files\/(\d+_[\w-]+)\/\2\.txt$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.origin !== new URL(MIRROR_PREFIX).origin ||
        url.port || url.username || url.password || url.search || url.hash ||
        !match || match[1] !== person || !match[2].startsWith(work + "_")) return null;
    return url;
  } catch { return null; }
}

async function readLimited(url: URL, timeout: number): Promise<Uint8Array | null> {
  const response = await fetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(timeout) });
  if (!response.ok) return null; // Do not follow untrusted redirects.
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (declared > LIMIT) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMIT) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (total < 50) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function payload(data: string, contentType: string, source: string): Response {
  return new Response(data, {
    headers: { ...RESPONSE_HEADERS, "Content-Type": contentType, "X-Aozora-Source": source },
  });
}


export async function onRequestGet(context: { request: Request }): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const input = params.get("url") || "";
  let source: URL;
  try {
    if (input.length > 400) throw Error("URL too long");
    source = new URL(input);
    if (!accepted(source, source.pathname, true)) throw Error("Invalid source");
  } catch {
    return new Response("Invalid Aozora book URL", { status: 400 });
  }
  const parsed = /^\/cards\/(\d{6})\/files\/(\d+)_[\w-]+\.html$/.exec(source.pathname);
  if (!parsed) return new Response("Invalid Aozora path", { status: 400 });
  const [, person, work] = parsed;
  const mirrorArgument = params.get("text") || "";
  const mirror = validMirror(mirrorArgument, person, work);
  if (mirrorArgument && !mirror) return new Response("Invalid Aozora mirror URL", { status: 400 });

  // The official origin and official renewal are always first choice.
  for (const origin of ["https://" + OFFICIAL_HOST, "https://" + RENEWAL_HOST]) {
    const response = await downloadFrom(origin, source.pathname);
    if (response) return response;
  }
  // A secondary curated corpus accepts only deterministic IDs from the
  // official, already-validated path; it is not an arbitrary proxy.
  const soranoha = new URL("https://soranoha.org/works/" +
    work.padStart(6, "0") + "_" + person + "/markdown");
  try {
    const bytes = await readLimited(soranoha, 9000);
    if (bytes) {
      const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (markdown.trim().length > 50 && !/<html\b/i.test(markdown)) {
        return payload(markdown, "text/markdown; charset=utf-8", "soranoha");
      }
    }
  } catch { /* Some works are absent from the alternate corpus. */ }

  // The optional text archive location must match the official work/card and
  // the fixed public GitHub mirror path; no user-controlled destination.
  if (mirror) {
    try {
      const bytes = await readLimited(mirror, 9000);
      if (bytes) {
        const plain = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (plain.trim().length > 50 && !/<html\b/i.test(plain)) {
          return payload(plain, "text/plain; charset=utf-8", "aozorahack");
        }
      }
    } catch { /* No other redirects, hosts or unverified sources. */ }
  }
  return new Response("Aozora original, renewal and public backup sources unavailable", {
    status: 503, headers: RESPONSE_HEADERS,
  });
}
