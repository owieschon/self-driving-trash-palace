import 'server-only'

/**
 * The local stack selects one seeded Palace through server configuration. A hosted multi-Palace
 * selector can replace this adapter without teaching browser code a fixture identifier.
 */
export function configuredPalaceId(): string | null {
  return process.env.TRASH_PALACE_LOCAL_PALACE_ID ?? null
}
