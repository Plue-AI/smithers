/** Bounded JSON transport shared by the host and its context callback.
 * @since 1.0.0
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * Reads at most MAX_BODY_BYTES of the body as JSON. The byte count is taken
 * while streaming, so a chunked body with no content-length is cancelled at
 * the limit instead of being buffered whole.
 *
 * @private
 * @since 1.0.0
 */
export const boundedJson = async (request: Request | Response): Promise<unknown | undefined> => {
  try {
    const length = Number(request.headers.get("content-length") ?? "0")
    if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
      await request.body?.cancel()
      return undefined
    }
    if (request.body === null) return undefined
    const reader = request.body.getReader()
    const chunks: Array<Uint8Array> = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        return undefined
      }
      chunks.push(value)
    }
    if (size === 0) return undefined
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  } catch {
    return undefined
  }
}
