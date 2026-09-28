/**
 * The checks every API request passes before it reaches a Durable Object:
 * browser origin and session-id shape. The credential check (`authorized`) and
 * the JSON media type and body cap (`readJson`, `MAX_BODY_BYTES`) are
 * `@smthrs/create-app/http`'s, the same ones `turnResponse` applies.
 *
 * They live here rather than inline in the switch because each one is a
 * security claim `README.md` and `worker/README.md` make, and a claim a test
 * can drive directly is a claim that stays true. The API shipped with none of
 * them while `CreateApp` ships `deploy` as a first-class target with a custom
 * domain, so a deployed app let any caller allocate unbounded Durable Object
 * storage, read or overwrite any session id it guessed, and post a body of any
 * size.
 *
 * What these bounds are NOT: they are not tenancy. One shared token means one
 * tenant, so a holder of the token still reaches every session. Per-session
 * storage growth, model spend, and request rate stay unbounded. `worker/README.md`
 * says so in the same words.
 */
import { INDEX_SESSION } from "./registry.ts"

/**
 * The shape a session id must have before it names a Durable Object.
 *
 * The shell mints `ses_<uuid>` (`src/shell/store.ts`), and this accepts that
 * plus any other flat identifier. What it refuses is what matters: a separator
 * or whitespace, a leading punctuation character, an empty string, and anything
 * past 128 characters, so a caller cannot name an object with a megabyte of
 * text or a path-shaped string that reads like a traversal.
 */
export const SESSION_ID = /^[A-Za-z0-9][\w.:-]{0,127}$/

/**
 * Whether `value` may name a session's Durable Object.
 *
 * {@link INDEX_SESSION} is refused separately from the shape: it is the
 * well-known object holding the session list, and a caller that addressed it as
 * an ordinary session wrote its own transcript into the registry's tables.
 */
export const isSessionId = (value: string): boolean => value !== INDEX_SESSION && SESSION_ID.test(value)

/** Browser metadata must name this origin; absent headers support non-browser clients. */
export const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin")
  const site = request.headers.get("sec-fetch-site")
  return (origin === null || origin === new URL(request.url).origin)
    && (site === null || site === "same-origin")
}
