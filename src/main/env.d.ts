/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_MICROSOFT_CLIENT_ID?: string
  readonly MAIN_VITE_MICROSOFT_TENANT?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
