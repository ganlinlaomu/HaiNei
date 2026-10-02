import type {
  RecoveryBackup,
  RecoveryProviderAdapter,
  RecoveryProviderSession,
} from "@/services/recovery/types";

const API_ROOT = "https://www.googleapis.com/drive/v3";
const UPLOAD_ROOT = "https://www.googleapis.com/upload/drive/v3";
const BACKUP_PREFIX = "hainei_bk_";
const BACKUP_SUFFIX = ".bin";

export class GoogleDriveAuthorizationExpiredError extends Error {
  constructor() {
    super("Google 授权已过期，请重新登录");
    this.name = "GoogleDriveAuthorizationExpiredError";
  }
}

function ensureGoogleSession(session: RecoveryProviderSession) {
  if (session.provider !== "google" || !session.subject || !session.accessToken) {
    throw new Error("Google 恢复会话无效");
  }
}

function opaqueFilename() {
  const id = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${BACKUP_PREFIX}${id}${BACKUP_SUFFIX}`;
}

export class GoogleDriveBackupService implements RecoveryProviderAdapter {
  readonly provider = "google" as const;
  readonly subject: string;
  private readonly accessToken: string;

  constructor(session: RecoveryProviderSession) {
    ensureGoogleSession(session);
    this.subject = session.subject;
    this.accessToken = session.accessToken!;
  }

  private async request(url: string, init: RequestInit = {}) {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${this.accessToken}`,
      },
      cache: "no-store",
    });
    if (response.status === 401) throw new GoogleDriveAuthorizationExpiredError();
    return response;
  }

  async listBackups(): Promise<RecoveryBackup[]> {
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      q: `name contains '${BACKUP_PREFIX}'`,
      fields: "files(id,name,modifiedTime)",
      pageSize: "100",
    });
    const response = await this.request(`${API_ROOT}/files?${params.toString()}`);
    if (!response.ok) throw new Error(`读取 Google Drive 备份失败（${response.status}）`);
    const body = await response.json() as { files?: Array<{ id?: string; name?: string; modifiedTime?: string }> };
    return (body.files || [])
      .filter(file =>
        !!file.id
        && !!file.name
        && file.name.startsWith(BACKUP_PREFIX)
        && file.name.endsWith(BACKUP_SUFFIX)
      )
      .map(file => ({
        id: file.id!,
        name: file.name!,
        modifiedTime: file.modifiedTime,
      }))
      .sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || ""));
  }

  async downloadBackup(id: string): Promise<string> {
    if (!id) throw new Error("Google Drive 备份 ID 为空");
    const response = await this.request(`${API_ROOT}/files/${encodeURIComponent(id)}?alt=media`);
    if (!response.ok) throw new Error(`下载 Google Drive 备份失败（${response.status}）`);
    return response.text();
  }

  async uploadBackup(payload: string): Promise<RecoveryBackup> {
    const name = opaqueFilename();
    const boundary = `hainei-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`;
    const crlf = "\r\n";
    const metadata = JSON.stringify({ name, parents: ["appDataFolder"] });
    const body = new Blob([
      `--${boundary}${crlf}`,
      `Content-Type: application/json; charset=UTF-8${crlf}${crlf}`,
      metadata,
      crlf,
      `--${boundary}${crlf}`,
      `Content-Type: application/octet-stream${crlf}${crlf}`,
      payload,
      crlf,
      `--${boundary}--${crlf}`,
    ], { type: `multipart/related; boundary=${boundary}` });

    const response = await this.request(
      `${UPLOAD_ROOT}/files?uploadType=multipart&fields=id,name,modifiedTime`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    if (!response.ok) throw new Error(`上传 Google Drive 备份失败（${response.status}）`);
    const created = await response.json() as { id?: string; name?: string; modifiedTime?: string };
    if (!created.id) throw new Error("Google Drive 未返回备份 ID");
    return {
      id: created.id,
      name: created.name || name,
      modifiedTime: created.modifiedTime,
    };
  }

  async deleteBackup(id: string): Promise<void> {
    if (!id) return;
    const response = await this.request(`${API_ROOT}/files/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`删除 Google Drive 备份失败（${response.status}）`);
    }
  }
}

export const googleDriveBackupNaming = Object.freeze({
  prefix: BACKUP_PREFIX,
  suffix: BACKUP_SUFFIX,
});
