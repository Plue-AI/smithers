import { Data } from "effect"
import { timingSafeEqual } from "node:crypto"
import { deflateSync } from "node:zlib"

const MAX_BODY_BYTES = 1024 * 1024
const encoder = new TextEncoder()

export interface PackagedE2EBridgeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly state: () => unknown | Promise<unknown>
  readonly evaluate: (script: string) => unknown | Promise<unknown>
  readonly screenshot: () => Uint8Array | null | Promise<Uint8Array | null>
  readonly quit: () => void | Promise<void>
}

export interface PackagedE2EBridge {
  readonly port: number
  readonly stop: () => void
}

const json = (status: number, body: unknown, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers
    }
  })

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const authorized = (request: Request, token: string): boolean => {
  const supplied = request.headers.get("authorization")
  const expected = `Bearer ${token}`
  if (supplied === null) return false
  const suppliedBytes = encoder.encode(supplied)
  const expectedBytes = encoder.encode(expected)
  return suppliedBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(suppliedBytes, expectedBytes)
}

const readJsonBody = async (request: Request): Promise<unknown> => {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new BridgeRequestError(413, "body_too_large", "Request body is too large.")
  }
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new BridgeRequestError(413, "body_too_large", "Request body is too large.")
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new BridgeRequestError(400, "invalid_json", "Request body must be JSON.")
  }
}

const readEvalScript = async (request: Request): Promise<string> => {
  const body = await readJsonBody(request)
  const script = typeof body === "object" && body !== null && "script" in body
    ? (body as { readonly script?: unknown }).script
    : undefined
  if (typeof script !== "string") {
    throw new BridgeRequestError(400, "invalid_request", "Body must be { script: string }.")
  }
  return script
}

class BridgeRequestError extends Data.TaggedError("BridgeRequestError")<{
  readonly status: number
  readonly code: string
  readonly message: string
}> {
  constructor(status: number, code: string, message: string) {
    super({ status, code, message })
  }
}

/**
 * Starts the packaged-app bridge only under the explicit, authenticated E2E
 * contract. Normal production launches return before opening a socket.
 */
export const startPackagedE2EBridge = (
  options: PackagedE2EBridgeOptions
): PackagedE2EBridge | null => {
  const env = options.env ?? Bun.env
  if (env.SMITHERS_E2E_BRIDGE !== "1") return null

  const port = Number(env.SMITHERS_E2E_BRIDGE_PORT)
  const token = env.SMITHERS_E2E_BRIDGE_TOKEN
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SMITHERS_E2E_BRIDGE_PORT must be an integer from 1 through 65535.")
  }
  if (token === undefined || token.length < 32) {
    throw new Error("SMITHERS_E2E_BRIDGE_TOKEN must contain at least 32 characters.")
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: async (request) => {
      if (!authorized(request, token)) {
        return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" })
      }

      const url = new URL(request.url)
      try {
        if (url.pathname === "/health" && request.method === "GET") {
          return json(200, { ok: true, pid: process.pid })
        }
        if (url.pathname === "/state" && request.method === "GET") {
          return json(200, await options.state())
        }
        if (url.pathname === "/window/eval" && request.method === "POST") {
          const result = await options.evaluate(await readEvalScript(request))
          return json(200, result === undefined ? { result: null, valueUndefined: true } : { result })
        }
        if (url.pathname === "/window/screenshot" && request.method === "GET") {
          const screenshot = await options.screenshot()
          if (screenshot === null) {
            return json(503, {
              error: "screenshot_unavailable",
              message: "Screen capture is unavailable or has not been permitted."
            })
          }
          return new Response(Uint8Array.from(screenshot).buffer, {
            headers: {
              "cache-control": "no-store",
              "content-type": "image/png",
              "x-content-type-options": "nosniff"
            }
          })
        }
        if (url.pathname === "/app/quit" && request.method === "POST") {
          setTimeout(() => void Promise.resolve(options.quit()), 25)
          return json(202, { ok: true })
        }

        const allowed = url.pathname === "/health" || url.pathname === "/state" ||
            url.pathname === "/window/screenshot" ?
          "GET" :
          url.pathname === "/window/eval" || url.pathname === "/app/quit"
          ? "POST"
          : undefined
        return allowed === undefined
          ? json(404, { error: "not_found" })
          : json(405, { error: "method_not_allowed" }, { allow: allowed })
      } catch (error) {
        if (error instanceof BridgeRequestError) {
          return json(error.status, { error: error.code, message: error.message })
        }
        return json(500, { error: "bridge_error", message: errorMessage(error) })
      }
    }
  })

  console.log(`Smithers E2E bridge listening on http://127.0.0.1:${server.port}`)
  let stopped = false
  return {
    port,
    stop: () => {
      if (stopped) return
      stopped = true
      server.stop(true)
    }
  }
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
  crcTable[index] = value >>> 0
}

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ crc >>> 8
  return (crc ^ 0xffffffff) >>> 0
}

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = encoder.encode(type)
  const chunk = new Uint8Array(12 + data.byteLength)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.byteLength)
  chunk.set(typeBytes, 4)
  chunk.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(chunk.subarray(4, 8 + data.byteLength)))
  return chunk
}

/** Encodes Electrobun Screen.captureRegion's bottom-up RGBA bytes without another dependency. */
export const encodeRgbaPng = (width: number, height: number, pixels: Uint8Array): Uint8Array => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("PNG dimensions must be positive integers.")
  }
  if (pixels.byteLength !== width * height * 4) throw new Error("RGBA byte length does not match the PNG dimensions.")

  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header.set([8, 6, 0, 0, 0], 8)

  const stride = width * 4
  const scanlines = new Uint8Array((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    const target = row * (stride + 1)
    const source = (height - row - 1) * stride
    scanlines[target] = 0
    scanlines.set(pixels.subarray(source, source + stride), target + 1)
  }

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", new Uint8Array())
  ]
  const png = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.byteLength
  }
  return png
}
