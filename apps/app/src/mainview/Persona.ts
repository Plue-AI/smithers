/*
 * One identity → one color, everywhere.
 *
 * An agent, a persona, a person: each is drawn as a two-letter monogram on a
 * lane color, and the SAME identity gets the SAME color in a thread, in the
 * organization chart, in a timeline and in the inbox. The color is a stable
 * hash of the identity's id, so it survives reloads and needs no table. The
 * six lane tokens (`--lane-0` … `--lane-5`) are the app's own; a new palette
 * redefines them and every monogram follows.
 */

/** Who posted, acted or owns something: the display name and the stable id it colors by. */
export interface PersonaRef {
  readonly id: string
  readonly name: string
  readonly iconUrl?: string | undefined
  /** The organization agent this identity resolves to, when it does. */
  readonly agentId?: string | undefined
}

export const LANE_COUNT = 6

/** The lane index an identity paints with: a stable hash of its id over the six lane tokens. */
export const personaLane = (id: string): number => {
  let hash = 2166136261
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash % LANE_COUNT
}

/**
 * Two letters for a name: the initials of its first two words, or the first
 * two letters of a one-word name. Punctuation and articles do not count.
 */
export const monogram = (name: string): string => {
  const words = name.split(/[\s_\-·/&]+/).map((word) => word.replace(/[^\p{L}\p{N}]/gu, "")).filter((word) => word !== "" && !/^(and|of|the|a|an)$/i.test(word))
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return `${words[0]!.charAt(0)}${words[1]!.charAt(0)}`.toUpperCase()
}

/** A persona named after a configured agent profile resolves to it by id, then by exact name, and wears the profile's name. */
export const resolvePersona = (
  persona: { readonly id?: string | undefined; readonly name: string; readonly iconUrl?: string | undefined },
  agents: ReadonlyArray<{ readonly id: string; readonly name: string }>
): PersonaRef => {
  const id = persona.id ?? persona.name
  const agent = agents.find((row) => row.id === id) ?? agents.find((row) => row.name.toLowerCase() === persona.name.toLowerCase())
  return { id: agent?.id ?? id, name: agent?.name ?? persona.name, iconUrl: persona.iconUrl, agentId: agent?.id }
}
