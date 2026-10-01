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
import { deviceStorage } from "@/services/deviceStorage";

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
    const serversJson = deviceStorage.getItem("blossom_servers");
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
      const rawUrl = (deviceStorage.getItem("blossom_upload_url") || "").trim();
      const token = (deviceStorage.getItem("blossom_token") || "").trim();
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
    
    const timeoutMs = parseInt(deviceStorage.getItem("blossom_timeout_ms") || "") || 60000;
    const authHeaderName = (deviceStorage.getItem("blossom_auth_header") || "Authorization").trim() || "Authorization";
    
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

function uploadAbortError(message = "upload_aborted") {
  const error: any = new Error(message);
  error.name = "AbortError";
  error.phase = "aborted";
  return error;
}

function uploadTimeoutError(phase: string, message: string) {
  const error: any = makePhaseError(phase, message);
  error.name = "TimeoutError";
  return error;
}

function signalError(signal: AbortSignal, fallback = uploadAbortError()) {
  return signal.reason instanceof Error ? signal.reason : fallback;
}

function createUploadBudget(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(uploadAbortError());
  };
  if (parentSignal?.aborted) abortFromParent();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(uploadTimeoutError("attempt_timeout", `媒体服务尝试超时 (${timeoutMs} ms)`));
    }
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, deadline - Date.now()),
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

async function withUploadSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signalError(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signalError(signal));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

async function headProbe(
  uploadUrl: string,
  headers: Record<string,string>,
  parentSignal: AbortSignal,
  timeoutMs: number,
) {
  if (parentSignal.aborted) throw signalError(parentSignal);
  const controller = new AbortController();
  let stageTimedOut = false;
  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(signalError(parentSignal));
  };
  parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    stageTimedOut = true;
    controller.abort(uploadTimeoutError("head_timeout", "HEAD /upload 超时"));
  }, Math.max(1, Math.min(8_000, timeoutMs)));

  let resp: Response;
  try {
    resp = await fetch(uploadUrl, { method: "HEAD", headers, signal: controller.signal });
  } catch (error) {
    if (parentSignal.aborted) throw signalError(parentSignal);
    if (stageTimedOut) throw uploadTimeoutError("head_timeout", "HEAD /upload 超时");
    if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
    throw makePhaseError("head_failed", "HEAD /upload 网络请求失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abortFromParent);
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
    signal?: AbortSignal;
  }
): Promise<{ url: string; sha256?: string; size?: number; type?: string; uploaded?: number }> {
  const cfg = await getBlossomConfig();
  const uploadUrl = options?.uploadUrl ?? cfg.url;
  const uploadToken = options?.uploadToken ?? cfg.token ?? "";
  const serverBaseUrl = normalizeMediaUrl(options?.serverBaseUrl || uploadUrl || "")
    || String(options?.serverBaseUrl || uploadUrl || "").replace(/\/upload\/?$/i, "").replace(/\/+$/, "");

  if (!uploadUrl) throw makeDetailedError("未配置 blossom_upload_url");

  const timeoutMs = options?.timeoutMs ?? cfg.timeoutMs;
  const budget = createUploadBudget(options?.signal, timeoutMs);
  const remaining = () => {
    const value = budget.remaining();
    if (value <= 0) throw uploadTimeoutError("attempt_timeout", `媒体服务尝试超时 (${timeoutMs} ms)`);
    return value;
  };

  try {
    if (budget.signal.aborted) throw signalError(budget.signal);

    const size = file.size;
    const type = file.type || "application/octet-stream";
    const shaHex = await withUploadSignal(sha256HexFromFile(file), budget.signal);

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
      const record = await getMediaSession(
        serverBaseUrl,
        options.accountPubkey,
        options.signEvent,
        false,
        size,
        shaHex,
        budget.signal
      );
      bearerAuthorizationHeaderValue = `Bearer ${record.token}`;
      baseHeaders["Authorization"] = bearerAuthorizationHeaderValue;
    }

    let head = await headProbe(uploadUrl, baseHeaders, budget.signal, Math.min(8_000, remaining()));

    let authorizationHeaderValue: string | undefined;
    if (head.status === 401 && !uploadToken && typeof options?.signEvent === "function") {
      if (options.managedHaiNeiServer && bearerAuthorizationHeaderValue && serverBaseUrl && options.accountPubkey) {
        clearMediaSession(serverBaseUrl, options.accountPubkey);
        const refreshed = await getMediaSession(
          serverBaseUrl,
          options.accountPubkey,
          options.signEvent,
          true,
          size,
          shaHex,
          budget.signal
        );
        bearerAuthorizationHeaderValue = `Bearer ${refreshed.token}`;
        head = await headProbe(
          uploadUrl,
          { ...baseHeaders, Authorization: bearerAuthorizationHeaderValue },
          budget.signal,
          Math.min(8_000, remaining())
        );
      }
    }

    if ((head.status === 401 || head.status === 403)
      && !uploadToken
      && !bearerAuthorizationHeaderValue
      && typeof options?.signEvent === "function") {
      const evtToSign = normalizeAuthEventForSigning({
        content: `Upload ${file.name}`,
        tags: [["t", "upload"], ["x", shaHex]]
      }, 3600);

      let signed: any;
      try {
        signed = await withUploadSignal(Promise.resolve(options.signEvent(evtToSign)), budget.signal);
      } catch (error: any) {
        if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
        throw makeDetailedError("签名授权事件失败", {
          error: error?.message ? error.message : String(error)
        });
      }
      if (!signed || signed.kind !== 24242 || !signed.sig || !signed.pubkey) {
        throw makeDetailedError("签名事件无效：期望返回含有 kind=24242, pubkey, sig 的签名事件", { signed });
      }

      authorizationHeaderValue = buildBud11AuthorizationHeader(signed);
      head = await headProbe(
        uploadUrl,
        { ...baseHeaders, Authorization: authorizationHeaderValue },
        budget.signal,
        Math.min(8_000, remaining())
      );
    }

    if (!head.ok) {
      throw makePhaseError(
        "head_failed",
        `HEAD /upload 被拒绝，HTTP ${head.status}${head.details?.reason ? `: ${head.details.reason}` : ""}`,
        head.details
      );
    }

    const sendPut = (authHeaderValue?: string) => new Promise<any>((resolve, reject) => {
      if (budget.signal.aborted) {
        reject(signalError(budget.signal));
        return;
      }

      const xhr = new XMLHttpRequest();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const finish = (error?: any, result?: any) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        budget.signal.removeEventListener("abort", onBudgetAbort);
        if (error) reject(error);
        else resolve(result);
      };

      const onBudgetAbort = () => {
        if (settled) return;
        const reason = signalError(budget.signal);
        if (reason.name === "TimeoutError") {
          finish(uploadTimeoutError("put_timeout", "上传超时"));
        } else {
          finish(reason);
        }
        try { xhr.abort(); } catch {}
      };

      try {
        xhr.open("PUT", uploadUrl, true);
        try { xhr.setRequestHeader("Content-Type", type); } catch {}
        try { xhr.setRequestHeader("X-SHA-256", shaHex); } catch {}
        if (authHeaderValue) {
          try { xhr.setRequestHeader("Authorization", authHeaderValue); } catch {}
        }

        xhr.upload.onprogress = (event) => {
          if (settled || typeof options?.onProgress !== "function") return;
          if (event.lengthComputable) {
            const progress = Math.round((event.loaded / event.total) * 100);
            try { options.onProgress(progress); } catch {}
          }
        };

        xhr.onreadystatechange = () => {
          if (settled || xhr.readyState !== 4) return;
          const status = xhr.status;
          const text = xhr.responseText || "";
          const responseHeaders = xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : undefined;
          if (status >= 200 && status < 300) {
            if (typeof options?.onProgress === "function") {
              try { options.onProgress(100); } catch {}
            }
            let json: any = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              finish(makePhaseError("descriptor_invalid", "上传成功但服务器返回无法解析的 JSON 描述", {
                responseText: text,
                responseHeaders
              }));
              return;
            }
            if (!json || typeof json.url !== "string" || !json.url.trim()) {
              finish(makePhaseError("descriptor_invalid", "服务器返回的 Blob descriptor 缺少 url 字段", {
                descriptor: json,
                responseHeaders
              }));
              return;
            }
            finish(undefined, json);
            return;
          }

          let message = `上传失败，HTTP ${status}`;
          try {
            const body = text ? JSON.parse(text) : null;
            if (body && (body.error || body.message)) message += `: ${body.error || body.message}`;
            else if (text) message += `: ${text}`;
          } catch {
            if (text) message += `: ${text}`;
          }
          finish(makePhaseError("put_network_error", message, {
            status,
            responseText: text,
            responseHeaders
          }));
        };

        xhr.onerror = () => finish(makePhaseError(
          "put_network_error",
          "网络错误：XHR 上传失败（可能为 CORS 或 网络问题）"
        ));
        xhr.onabort = () => {
          if (!settled) finish(makePhaseError("put_network_error", "上传被中止"));
        };

        budget.signal.addEventListener("abort", onBudgetAbort, { once: true });
        timer = setTimeout(() => {
          if (settled) return;
          finish(uploadTimeoutError("put_timeout", `上传超时 (${timeoutMs} ms 总预算)`));
          try { xhr.abort(); } catch {}
        }, Math.max(1, remaining()));

        if (budget.signal.aborted) {
          onBudgetAbort();
          return;
        }

        try {
          xhr.send(file);
        } catch (sendError) {
          finish(makePhaseError("put_network_error", "XHR 发送失败", {
            sendErr: sendError instanceof Error ? sendError.message : String(sendError)
          }));
        }
      } catch (error: any) {
        finish(makePhaseError("put_network_error", "上传流程异常", {
          error: error?.message ? error.message : String(error)
        }));
      }
    });

    let effectiveAuthorizationHeaderValue =
      authorizationHeaderValue || bearerAuthorizationHeaderValue || (uploadToken || undefined);
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
        const refreshed = await getMediaSession(
          serverBaseUrl,
          options.accountPubkey,
          options.signEvent,
          true,
          size,
          shaHex,
          budget.signal
        );
        effectiveAuthorizationHeaderValue = `Bearer ${refreshed.token}`;
        const retryHead = await headProbe(
          uploadUrl,
          { ...baseHeaders, Authorization: effectiveAuthorizationHeaderValue },
          budget.signal,
          Math.min(8_000, remaining())
        );
        if (!retryHead.ok) {
          throw makePhaseError(
            "head_failed",
            `HEAD /upload 被拒绝，HTTP ${retryHead.status}${retryHead.details?.reason ? `: ${retryHead.details.reason}` : ""}`,
            retryHead.details
          );
        }
        putResult = await sendPut(effectiveAuthorizationHeaderValue);
      } else {
        throw error;
      }
    }

    return putResult;
  } finally {
    budget.cleanup();
  }
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
    signal?: AbortSignal;
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
      signal: options?.signal,
      uploadUrl: normalizeBlossomUploadUrl(current.url),
      uploadToken: managedHaiNeiServer ? "" : current.token || "",
      serverBaseUrl: current.url,
      managedHaiNeiServer,
    });
    },
    (current, ok) => reportHealth?.(current.id, ok, Date.now()),
    error => error instanceof Error && error.name === "AbortError"
  );
  return { ...result, serverUsed: normalizeBlossomUploadUrl(server.url) };
}
