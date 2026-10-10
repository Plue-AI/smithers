import { Console, Effect } from "effect"

/**
 * Names one source refusal site. The refusal's message carries only the site;
 * the compared native identities, never credentials, go to the current
 * `Console` beside it.
 */
export const sourceRefusal = (
  reason: string,
  values: Readonly<Record<string, unknown>> = {}
): Effect.Effect<string> => {
  const message = `source_refused: ${reason}`
  return Console.warn(message, JSON.stringify(values)).pipe(Effect.as(message))
}
