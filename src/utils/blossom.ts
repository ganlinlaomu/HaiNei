// Blossom client (BUD-02 / BUD-06 / BUD-01 compliant)
// - HEAD /upload preflight using X-SHA-256, X-Content-Type, X-Content-Length
// - If server requires authorization, create kind=24242 authorization event (adds expiration if missing),
//   call signEvent callback to sign it, then send it as Authorization: Nostr <base64url(json)>
//   (BUD-11 requires URL-safe Base64 without padding and the "Nostr" scheme).
// - PUT /upload with raw binary body, returns Blob Descriptor { url, sha256, size, type, uploaded }
//
// Notes:
// - signEvent callback must accept an event object and return the signed event object (with id, pubkey, sig).
// - We add a default expiration (now + 1 hour) if none present on the event before calling signEvent.
// - The Authorization header value is "Nostr <base64url(json)>", where json is the signed event JSON.
//
// Usage:
//   import { uploadImageToBlossom, getBlossomConfig } from "@/utils/blossom";
//   await uploadImageToBlossom(file, { signEvent: async evt => signedEvt, onProgress(p){}, timeoutMs: 60000 })

import {
  DEFAULT_MEDIA_SERVERS,
  normalizeMediaUrl,
  rankMediaServers,
  runMediaFailover,
  type MediaServer,
  type MediaServerType
} from "@/services/connectionSettings";
import { clearMediaSession, getMediaSession } from "@/services/mediaSession";

export const DEFAULT_BLOSSOM_SERVERS = [
  { url: DEFAULT_MEDIA_SERVERS[0].url, token: "" }
];

type MediaHealthReporter = (serverId: string, ok: boolean, at: number) => void;
let mediaHealthReporter: MediaHealthReporter | undefined;

export function setMediaHealthReporter(reporter?: MediaHealthReporter) {
  mediaHealthReporter = reporter;
}

function normalizeBlossomUploadUrl(input: string): string {
  let url = input.trim();
  
  // 1️⃣ 如果没写 scheme，默认补 https://
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  // 去掉末尾 /
  url = url.replace(/\/+$/, "");

  // 如果已经是 /upload，直接返回
  if (url.endsWith("/upload")) return url;

  // 否则统一补 /upload
  return url + "/upload";
}

export async function getBlossomConfig(): Promise<{
  url: string | null;
  token: string | null;
  timeoutMs: number;
  authHeaderName: string; // header name to send signed auth event; default "Authorization"
  servers: MediaServer[]; // Ordered active upload servers
}> {
  try {
    // Try to get servers list first (new format)
    const serversJson = localStorage.getItem("blossom_servers");
    const hasExplicitServerList = serversJson !== null;
    let servers: MediaServer[] = [];
    
    if (serversJson) {
      try {
        const parsed = JSON.parse(serversJson);
        if (Array.isArray(parsed)) {
          servers = parsed.map((s: any, index: number) => ({
            ...s,
            id: String(s.id || `legacy-media-${index}-${s.url || ""}`),
            type: (["blossom", "imgbed", "custom"].includes(s.type) ? s.type : "blossom") as MediaServerType,
            url: normalizeMediaUrl(s.url || ""),
            token: typeof s.token === "string" ? s.token.trim() : undefined,
            enabled: s.enabled !== false,
            priority: Number.isFinite(s.priority) ? Number(s.priority) : index,
            source: s.source === "default" ? "default" : "user",
            addedAt: Number(s.addedAt) || 0,
            updatedAt: Number(s.updatedAt) || 0,
            deleted: s.deleted === true
          })).filter((s: MediaServer) => s.url);
        }
      } catch (e) {
        console.warn("Failed to parse blossom_servers", e);
      }
    }
    
    // Fallback to single server config (old format)
    if (servers.length === 0 && !hasExplicitServerList) {
      const rawUrl = (localStorage.getItem("blossom_upload_url") || "").trim();
      const token = (localStorage.getItem("blossom_token") || "").trim();
      if (rawUrl) {
        servers.push({
          id: `legacy-media-${rawUrl}`,
          type: "blossom",
          url: normalizeMediaUrl(rawUrl),
          token,
          enabled: true,
          priority: 0,
          source: "user",
          addedAt: 0,
          updatedAt: 0
        });
      }
    }
    
    // If still no servers, use defaults
    if (servers.length === 0 && !hasExplicitServerList) {
      servers = DEFAULT_BLOSSOM_SERVERS.map((s, index) => ({
        id: DEFAULT_MEDIA_SERVERS[index]?.id || `default-media-${index}`,
        type: "blossom" as const,
        url: normalizeMediaUrl(s.url),
        token: s.token,
        enabled: true,
        priority: 1_000 + index,
        source: "default" as const,
        addedAt: 0,
        updatedAt: 0
      }));
    }

    servers = rankMediaServers(servers);
    
    const timeoutMs = parseInt(localStorage.getItem("blossom_timeout_ms") || "") || 60000;
    const authHeaderName = (localStorage.getItem("blossom_auth_header") || "Authorization").trim() || "Authorization";
    
    // Return first server as default for backward compatibility
    const url = servers.length > 0 ? normalizeBlossomUploadUrl(servers[0].url) : null;
    const token = servers.length > 0 ? servers[0].token || "" : null;
    
    return { url, token, timeoutMs, authHeaderName, servers };
  } catch {
    return { 
      url: null, 
      token: null, 
      timeoutMs: 60000, 
      authHeaderName: "Authorization",
      servers: []
    };
  }
}

function buf2hex(buffer: ArrayBuffer) {
  return Array.prototype.map.call(new Uint8Array(buffer), (x: number) => ("00" + x.toString(16)).slice(-2)).join("");
}

async function sha256HexFromFile(file: File): Promise<string> {
  const ab = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return buf2hex(digest);
}

function makeDetailedError(message: string, details?: any) {
  const err: any = new Error(message);
  if (details !== undefined) err.details = details;
  return err;
}

function makePhaseError(phase: string, message: string, details?: any) {
  const err: any = makeDetailedError(message, details);
  err.phase = phase;
  return err;
}

export function buildBud11AuthorizationHeader(event: unknown): string {
  const json = typeof event === "string" ? event : JSON.stringify(event);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `Nostr ${base64url}`;
}

async function headProbe(uploadUrl: string, headers: Record<string,string>) {
  let resp: Response;
  try {
    resp = await fetch(uploadUrl, { method: "HEAD", headers });
  } catch (error) {
    throw makePhaseError("head_failed", "HEAD /upload 网络请求失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const xReason = resp.headers.get("X-Reason") || undefined;
  const details = {
    status: resp.status,
    reason: xReason,
    responseHeaders: (() => { const h: Record<string,string> = {}; resp.headers.forEach((v,k)=>h[k]=v); return h; })()
  };
  return { ok: resp.ok, status: resp.status, details };
}

/**
 * Ensure authorization event meets BUD-01 requirements:
 * - kind must be 24242 (we expect caller to request authorization for upload/list/delete/get)
 * - created_at must be in the past (we set it to now if missing)
 * - must include ["t", <verb>] tag (upload/list/get/delete) - blossom.ts will create the event skeleton
 * - must include expiration tag ["expiration", "<unix_ts>"] in the future (we add default if missing)
 */
function normalizeAuthEventForSigning(evt: any, defaultExpirySeconds = 3600) {
  if (!evt || typeof evt !== "object") throw new Error("invalid auth event");
  // kind
  evt.kind = 24242;
  // created_at: must be in the past
  const now = Math.floor(Date.now() / 1000);
  if (!evt.created_at || typeof evt.created_at !== "number" || evt.created_at > now) {
    evt.created_at = now;
  }
  // tags: ensure it's an array-of-arrays
  evt.tags = Array.isArray(evt.tags) ? evt.tags : [];
  // ensure expiration tag exists and is in the future
  const hasExpiration = evt.tags.some((t: any[]) => Array.isArray(t) && t[0] === "expiration" && Number(t[1]) > now);
  if (!hasExpiration) {
    evt.tags.push(["expiration", String(now + defaultExpirySeconds)]);
  }
  return evt;
}

/**
 * uploadImageToBlossom
 * - file: File to upload
 * - options:
 *    uploadUrl?: string (override the configured server URL)
 *    uploadToken?: string (override the configured token)
 *    signEvent?: (evt) => signedEventObject
 *    onProgress?: (percent:number) => void
 *    timeoutMs?: number
 */
export async function uploadImageToBlossom(
  file: File,
  options?: {
    uploadUrl?: string;
    uploadToken?: string;
    serverBaseUrl?: string;
    managedHaiNeiServer?: boolean;
    accountPubkey?: string;
    signEvent?: (evt:any) => Promise<any> | any;
    onProgress?: (p:number)=>void;
    timeoutMs?: number;
  }
): Promise<{ url: string; sha256?: string; size?: number; type?: string; uploaded?: number }> {
  const cfg = await getBlossomConfig();
  const uploadUrl = options?.uploadUrl ?? cfg.url;
  const uploadToken = options?.uploadToken ?? cfg.token ?? "";
  const serverBaseUrl = normalizeMediaUrl(options?.serverBaseUrl || uploadUrl || "")
    || String(options?.serverBaseUrl || uploadUrl || "").replace(/\/upload\/?$/i, "").replace(/\/+$/, "");
  
  if (!uploadUrl) throw makeDetailedError("未配置 blossom_upload_url");

  const timeoutMs = options?.timeoutMs ?? cfg.timeoutMs;
  const size = file.size;
  const type = file.type || "application/octet-stream";
  const shaHex = await sha256HexFromFile(file);

  // base headers for HEAD probe (BUD-06)
  const baseHeaders: Record<string,string> = {
    "X-SHA-256": shaHex,
    "X-Content-Length": String(size),
    "X-Content-Type": type
  };
  let bearerAuthorizationHeaderValue: string | undefined;
  if (uploadToken) {
    baseHeaders["Authorization"] = uploadToken;
  } else if (options?.managedHaiNeiServer) {
    if (!serverBaseUrl || !options.accountPubkey || typeof options.signEvent !== "function") {
      throw makeDetailedError("HaiNei 默认媒体服务需要已登录的 Nostr 账号");
    }
    const record = await getMediaSession(serverBaseUrl, options.accountPubkey, options.signEvent, false, size);
    bearerAuthorizationHeaderValue = ["Bearer", record.token].join(" ");
    baseHeaders["Authorization"] = bearerAuthorizationHeaderValue;
  }

  // 1) HEAD probe without auth
  let head = await headProbe(uploadUrl, baseHeaders);

  // 2) If server requires auth (401/403) and signEvent provided, create authorization event, sign it,
  //    then put Authorization: Nostr <base64(json)> header and retry HEAD.
  let authorizationHeaderValue: string | undefined = undefined;
  if (head.status === 401 && !uploadToken && typeof options?.signEvent === "function") {
    if (options.managedHaiNeiServer && bearerAuthorizationHeaderValue && serverBaseUrl && options.accountPubkey) {
      clearMediaSession(serverBaseUrl, options.accountPubkey);
      const refreshed = await getMediaSession(serverBaseUrl, options.accountPubkey, options.signEvent, true, size);
      bearerAuthorizationHeaderValue = ["Bearer", refreshed.token].join(" ");
      const refreshedHeadHeaders = { ...baseHeaders, Authorization: bearerAuthorizationHeaderValue };
      head = await headProbe(uploadUrl, refreshedHeadHeaders);
    }
  }

  if ((head.status === 401 || head.status === 403) && !uploadToken && !bearerAuthorizationHeaderValue && typeof options?.signEvent === "function") {
    // create event skeleton per BUD-01/BUD-02: t tag "upload", x tag sha
    const evtSkeleton: any = {
      // kind, created_at and expiration handled in normalizeAuthEventForSigning
      content: `Upload ${file.name}`,
      tags: [["t", "upload"], ["x", shaHex]]
    };
    // normalize + add expiration if missing, set kind/created_at
    const evtToSign = normalizeAuthEventForSigning(evtSkeleton, 3600);
    let signed: any;
    try {
      signed = await options!.signEvent!(evtToSign);
    } catch (e: any) {
      throw makeDetailedError("签名授权事件失败", { error: e && e.message ? e.message : String(e) });
    }
    // Validate signed event minimally
    if (!signed || signed.kind !== 24242 || !signed.sig || !signed.pubkey) {
      // still allow but warn - server will likely reject
      // throw helpful error
      throw makeDetailedError("签名事件无效：期望返回含有 kind=24242, pubkey, sig 的签名事件", { signed });
    }

    // BUD-11 requires URL-safe Base64 without padding.
    authorizationHeaderValue = buildBud11AuthorizationHeader(signed);

    // retry HEAD with Authorization header
    const headersWithAuth = { ...baseHeaders };
    // If config.token is set as Authorization bearer, keep it in a separate header name scenario is unlikely.
    // BUD-11 fixes the header name to Authorization. Do not allow a stale
    // local preference to silently move the signed event to another header.
    headersWithAuth["Authorization"] = authorizationHeaderValue;
    head = await headProbe(uploadUrl, headersWithAuth);
  }

  if (!head.ok) {
    // If HEAD failed, surface X-Reason if available (BUD-06)
    throw makePhaseError("head_failed", `HEAD /upload 被拒绝，HTTP ${head.status}` + (head.details?.reason ? `: ${head.details.reason}` : ""), head.details);
  }

  // 3) Proceed to PUT /upload with raw file body (BUD-02). Include Authorization header if we have it.
  const sendPut = (authHeaderValue?: string) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer: any = null;
    let settled = false;
    const finish = (err?: any, result?: any) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (err) reject(err); else resolve(result);
    };

    try {
      xhr.open("PUT", uploadUrl, true);
      try { xhr.setRequestHeader("Content-Type", type); } catch {}
      try { xhr.setRequestHeader("X-SHA-256", shaHex); } catch {}
      if (authHeaderValue) {
        try { xhr.setRequestHeader("Authorization", authHeaderValue); } catch {}
      }

      xhr.upload.onprogress = (ev) => {
        if (settled) return;
        if (typeof options?.onProgress === "function") {
          if (ev.lengthComputable) {
            const p = Math.round((ev.loaded / ev.total) * 100);
            try { options!.onProgress!(p); } catch {}
          }
        }
      };

      xhr.onreadystatechange = () => {
        if (settled) return;
        if (xhr.readyState !== 4) return;
        const status = xhr.status;
        const text = xhr.responseText || "";
        const respHeaders = xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : undefined;
        if (status >= 200 && status < 300) {
          // Ensure progress is set to 100% on success
          if (typeof options?.onProgress === "function") {
            try { options!.onProgress!(100); } catch {}
          }
          let json: any = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) {
            return finish(makePhaseError("descriptor_invalid", "上传成功但服务器返回无法解析的 JSON 描述", { responseText: text, responseHeaders: respHeaders }));
          }
          if (!json || typeof json.url !== "string" || !json.url.trim()) {
            return finish(makePhaseError("descriptor_invalid", "服务器返回的 Blob descriptor 缺少 url 字段", { descriptor: json, responseHeaders: respHeaders }));
          }
          return finish(undefined, json);
        } else {
          let errMsg = `上传失败，HTTP ${status}`;
          try {
            const j = text ? JSON.parse(text) : null;
            if (j && (j.error || j.message)) errMsg += `: ${j.error || j.message}`;
            else if (text) errMsg += `: ${text}`;
          } catch {
            if (text) errMsg += `: ${text}`;
          }
          return finish(makePhaseError("put_network_error", errMsg, { status, responseText: text, responseHeaders: respHeaders }));
        }
      };

      xhr.onerror = () => {
        if (settled) return;
        finish(makePhaseError("put_network_error", "网络错误：XHR 上传失败（可能为 CORS 或 网络问题）"));
      };
      xhr.onabort = () => {
        if (settled) return;
        finish(makePhaseError("put_network_error", "上传被中止"));
      };

      timer = setTimeout(() => {
        if (settled) return;
        finish(makePhaseError("put_timeout", `上传超时 (${timeoutMs} ms)`));
        try { xhr.abort(); } catch {}
      }, timeoutMs);

      try {
        xhr.send(file);
      } catch (sendErr) {
        finish(makePhaseError("put_network_error", "XHR 发送失败", { sendErr: sendErr instanceof Error ? sendErr.message : String(sendErr) }));
      }
    } catch (outerErr: any) {
      finish(makePhaseError("put_network_error", "上传流程异常", { error: outerErr && outerErr.message ? outerErr.message : String(outerErr) }));
    }
  });

  let effectiveAuthorizationHeaderValue = authorizationHeaderValue || bearerAuthorizationHeaderValue || (uploadToken || undefined);
  let putResult: any;
  try {
    putResult = await sendPut(effectiveAuthorizationHeaderValue);
  } catch (error: any) {
    const status = Number(error?.details?.status);
    if (
      status === 401
      && !uploadToken
      && !authorizationHeaderValue
      && bearerAuthorizationHeaderValue
      && options?.managedHaiNeiServer
      && serverBaseUrl
      && options?.accountPubkey
      && typeof options?.signEvent === "function"
    ) {
      clearMediaSession(serverBaseUrl, options.accountPubkey);
      const refreshed = await getMediaSession(serverBaseUrl, options.accountPubkey, options.signEvent, true, size);
      effectiveAuthorizationHeaderValue = ["Bearer", refreshed.token].join(" ");
      const retryHead = await headProbe(uploadUrl, { ...baseHeaders, Authorization: effectiveAuthorizationHeaderValue });
      if (!retryHead.ok) {
        throw makePhaseError("head_failed", `HEAD /upload 被拒绝，HTTP ${retryHead.status}` + (retryHead.details?.reason ? `: ${retryHead.details.reason}` : ""), retryHead.details);
      }
      putResult = await sendPut(effectiveAuthorizationHeaderValue);
    } else {
      throw error;
    }
  }

  return putResult;
}

/**
 * uploadImageToBlossomWithFallback
 * Tries configured media servers in deterministic priority order until one succeeds.
 * - file: File to upload
 * - options: Same as uploadImageToBlossom plus optional servers list
 * Returns: Upload result from the first successful server
 */
export async function uploadImageToBlossomWithFallback(
  file: File,
  options?: {
    accountPubkey?: string;
    signEvent?: (evt:any) => Promise<any> | any;
    onProgress?: (p:number)=>void;
    timeoutMs?: number;
    servers?: Array<Partial<MediaServer> & { url: string; token?: string }>;
  }
): Promise<{ url: string; sha256?: string; size?: number; type?: string; uploaded?: number; serverUsed?: string }> {
  const reportHealth = mediaHealthReporter;
  const cfg = await getBlossomConfig();
  const serverList: MediaServer[] = (options?.servers || cfg.servers).map((server, index) => ({
    id: server.id || `override-media-${index}-${server.url}`,
    type: server.type || "blossom",
    url: server.url,
    token: server.token || "",
    enabled: server.enabled !== false,
    priority: Number.isFinite(server.priority) ? Number(server.priority) : index,
    source: server.source === "default" ? "default" : "user",
    addedAt: Number(server.addedAt) || 0,
    updatedAt: Number(server.updatedAt) || 0,
    deleted: server.deleted === true,
    lastSuccessAt: server.lastSuccessAt,
    lastFailureAt: server.lastFailureAt,
    failureCount: server.failureCount
  }));
  
  if (!serverList || serverList.length === 0) {
    throw makeDetailedError("未配置 Blossom 图床服务器");
  }

  const { result, server } = await runMediaFailover(
    serverList,
    current => {
      const normalizedCurrent = normalizeMediaUrl(current.url);
      const managedHaiNeiServer = current.source === "default"
        && DEFAULT_MEDIA_SERVERS.some(defaultServer => normalizeMediaUrl(defaultServer.url) === normalizedCurrent);
      return uploadImageToBlossom(file, {
      accountPubkey: options?.accountPubkey,
      signEvent: options?.signEvent,
      onProgress: options?.onProgress,
      timeoutMs: options?.timeoutMs,
      uploadUrl: normalizeBlossomUploadUrl(current.url),
      uploadToken: managedHaiNeiServer ? "" : current.token || "",
      serverBaseUrl: current.url,
      managedHaiNeiServer,
    });
    },
    (current, ok) => reportHealth?.(current.id, ok, Date.now())
  );
  return { ...result, serverUsed: normalizeBlossomUploadUrl(server.url) };
}
