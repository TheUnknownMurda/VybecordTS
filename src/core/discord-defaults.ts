/** Official Vybecord Discord Application — used for Rich Presence by default. */
export const DEFAULT_DISCORD_APP_ID = '1396531182426128394';

/** Resolve Application ID: empty config → Vybecord default. */
export function resolveDiscordAppId(raw?: string | null): string {
  const id = (raw ?? process.env.DISCORD_CLIENT_ID ?? '').trim();
  return id || DEFAULT_DISCORD_APP_ID;
}
