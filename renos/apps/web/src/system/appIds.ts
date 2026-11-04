export const APP_IDS = ['files', 'library', 'installer', 'notes', 'terminal', 'settings', 'player'] as const;
export type AppId = (typeof APP_IDS)[number];

export function isAppId(value: unknown): value is AppId {
  return typeof value === 'string' && (APP_IDS as readonly string[]).includes(value);
}
