/** Deferred app cards stay hidden under #3447. @since 1.0.0 */
export const DEFERRED_CARD_KINDS = ["stack", "factory.home"] as const
/** Tombstones and deferred cards cannot be reopened or sent to a model. */
export const cardAvailable = (kind: string): boolean =>
  kind !== "retired" && !(DEFERRED_CARD_KINDS as readonly string[]).includes(kind)
