/** Strict Aozora gateway. The official XHTML is preferred; independent, public
 * text archives are only used when the official site is unreachable.
 * All destinations are derived from a validated Aozora work/card ID.
 */
const LIMIT = 5 * 1024 * 1024;
const HTML_PATH = /^\/cards\/(\d{6})\/files\/(\d+)_[\w-]+\.html$/;
const MIRROR_PREFIX = "https://raw.githubusercontent.com/aozorahack/aozorabunko_text/master";
const RESPONSE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function validOfficial(value: string): { url: URL; person: string; work: string } | null {
  try {
    if (value.length > 400) return null;
    const url = new URL(value);
    const match = HTML_PATH.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "www.aozora.gr.jp" ||
        url.port || url.username || url.password || url.search || url.hash || !match) return null;
    return { url, person: match[1], work: match[2] };
  } catch { return null; }
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
  const official = validOfficial(params.get("url") || "");
  if (!official) return new Response("Invalid Aozora book URL", { status: 400 });
  const mirrorArgument = params.get("text") || "";
  const mirror = validMirror(mirrorArgument, official.person, official.work);
  if (mirrorArgument && !mirror) return new Response("Invalid Aozora mirror URL", { status: 400 });

  try {
    const bytes = await readLimited(official.url, 9000);
    if (bytes) {
      const html = new TextDecoder("shift_jis").decode(bytes);
      if (/<(?:html|body|div|p)\b/i.test(html)) {
        return payload(html, "text/html; charset=utf-8", "official");
      }
    }
  } catch { /* DNS failures and timeouts can affect some Cloudflare locations. */ }

  // The work identifier, never a user-supplied remote URL, determines the path.
  const slug = official.work.padStart(6, "0") + "_" + official.person;
  const soranoha = new URL("https://soranoha.org/works/" + slug + "/markdown");
  try {
    const bytes = await readLimited(soranoha, 9000);
    if (bytes) {
      const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (markdown.trim().length > 50 && !/<html\b/i.test(markdown)) {
        return payload(markdown, "text/markdown; charset=utf-8", "soranoha");
      }
    }
  } catch { /* This independent collection does not contain every Aozora book. */ }

  // Aozorahack maintains uncompressed copies of Aozora's Shift-JIS text ZIPs.
  // A missing or inaccessible mirror is an ordinary unavailable-book error.
  if (mirror) {
    try {
      const bytes = await readLimited(mirror, 9000);
      if (bytes) {
        const plain = new TextDecoder("shift_jis").decode(bytes);
        if (plain.trim().length > 50 && !/<html\b/i.test(plain)) {
          return payload(plain, "text/plain; charset=utf-8", "aozorahack");
        }
      }
    } catch { /* No further untrusted hosts or redirects. */ }
  }
  return new Response("Official Aozora and backup text sources unavailable", {
    status: 503, headers: RESPONSE_HEADERS,
  });
}
