/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HAINEI_WORKER_URL?: string;
  readonly VITE_ENABLE_NIP46?: string;
  readonly VITE_GOOGLE_WEB_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
