/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RENOS_BACKEND?: 'server' | 'local';
  readonly VITE_RENOS_GAME_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
