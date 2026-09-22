export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface D1Database {
  prepare(query: string): D1Statement;
}

export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: D1Database;
  BLOSSOM: ServiceBinding;
  BLOSSOM_SERVICE_TOKEN: string;
  AUTH_CHALLENGE_TTL_SECONDS?: string;
  UPLOAD_TOKEN_TTL_SECONDS?: string;
  MAX_FILE_SIZE_BYTES?: string;
  DAILY_UPLOAD_COUNT?: string;
  DAILY_UPLOAD_BYTES?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function integerSetting(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
