/**
 * Request admission for a Worker route: a bearer-token check and a capped JSON
 * body read.
 *
 * `turnResponse` from `@smthrs/create-app/worker` applies both before it runs
 * a turn. They live apart from it so a Worker router can guard its own routes
 * without loading the agent runtime at module scope. Nothing here imports
 * anything; it runs in browsers, workerd, and Node.
 *
 * @since 1.0.0
 */

/**
 * The largest JSON body {@link readJson} reads by default, and the one
 * `turnResponse` reads unless its endpoint says otherwise.
 *
 * @category models
 * @since 1.0.0
 */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * A decoded body, or the refusal the route should answer with.
 *
 * `400` is a body that does not decode, `413` one past the size cap, and `415`
 * a media type other than `application/json`.
 *
 * @category models
 * @since 1.0.0
 */
export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413 | 415; readonly message: string }

const tooLarge = (limit: number): BodyResult => ({
  ok: false,
  status: 413,
  message: `Request body is larger than ${limit} bytes.`
})

/**
 * Reads a JSON body without ever buffering more than `limit` bytes.
 *
 * The media type must be `application/json`, which also keeps a cross-site
 * HTML form from posting here without a CORS preflight. A declared
 * `content-length` past the cap is refused before a byte is read, and the
 * running total bounds a body that declares no length. Passing the cap cancels
 * the source rather than draining it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const readJson = async (request: Request, limit: number = MAX_BODY_BYTES): Promise<BodyResult> => {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    return { ok: false, status: 415, message: "Expected Content-Type: application/json." }
  }

  const declared = request.headers.get("content-length")
  if (declared !== null && Number(declared) > limit) return tooLarge(limit)

  const body = request.body
  if (body === null) return { ok: false, status: 400, message: "Expected a JSON body." }

  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        return tooLarge(limit)
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, status: 400, message: "Request body could not be read." }
  }

  const buffer = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(buffer)) as unknown }
  } catch {
    return { ok: false, status: 400, message: "Request body is not JSON." }
  }
}

/**
 * Compares two strings without leaking where they first differ. The length
 * check leaks only the length, which a bearer token does not hide anyway.
 */
const sameSecret = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

/**
 * Whether `request` carries `Authorization: Bearer <token>`.
 *
 * A missing or empty `token` fails closed unless local development opts in
 * with `open === "1"`. A configured token always takes precedence over `open`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const authorized = (request: Request, token: string | undefined, open?: string): boolean => {
  if (token === undefined || token === "") return open === "1"
  const header = request.headers.get("authorization")
  if (header === null) return false
  const prefix = "Bearer "
  if (!header.startsWith(prefix)) return false
  return sameSecret(header.slice(prefix.length), token)
}
