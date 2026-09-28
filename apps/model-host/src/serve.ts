import {
  bearerAuthorization,
  createModelTurnHandler,
  environmentModelResolver,
  MODEL_HOST_PROTOCOL
} from "@smthrs/model-host"
import { createModelProbe } from "@smthrs/model-host/ModelProbe"
import { MODEL_TEST_BODY_MAX_BYTES, ModelTestRequestSchema } from "@smthrs/rpc/ConfiguredModel"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { parseArgs } from "node:util"

const parsed = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "0" },
    help: { type: "boolean", short: "h" }
  }
})

if (parsed.values.help) {
  process.stdout.write("smithers-model-host serve --host 127.0.0.1 --port 0\n")
  process.exit(0)
}
if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "serve") throw new Error("Expected serve command")
if (parsed.values.host !== "127.0.0.1" && parsed.values.host !== "::1" && parsed.values.host !== "localhost") {
  throw new Error("The public local model host must bind loopback")
}
const port = Number(parsed.values.port)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port")
const authorization = process.env.SMITHERS_CHAT_HOST_TOKEN ?? ""
const callbackBaseUrl = process.env.SMITHERS_CHAT_CALLBACK_URL ?? ""
const rawBinding = process.env.SMITHERS_CHAT_MODEL ?? ""
if (authorization === "" || callbackBaseUrl === "" || rawBinding === "") {
  throw new Error("Model host configuration is incomplete")
}
let binding: unknown
try {
  binding = JSON.parse(rawBinding)
} catch {
  throw new Error("SMITHERS_CHAT_MODEL must be JSON")
}
const requestedMaxTokens = Number(process.env.SMITHERS_CHAT_MAX_TOKENS ?? "4096")
if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens <= 0 || requestedMaxTokens > 1_000_000) {
  throw new Error("SMITHERS_CHAT_MAX_TOKENS is invalid")
}
const handle = createModelTurnHandler({
  authorization,
  callbackBaseUrl,
  resolve: environmentModelResolver({ binding, env: process.env, maxTokens: requestedMaxTokens })
})
const modelProbe = createModelProbe({ env: process.env, egress: true })
const authorized = bearerAuthorization(authorization)
const testModel = async (request: Request): Promise<Response> => {
  if (!authorized(request)) {
    return Response.json({ code: "unauthorized" }, { status: 401 })
  }
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MODEL_TEST_BODY_MAX_BYTES) return Response.json({ code: "request_invalid" }, { status: 400 })
  let body: unknown
  try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { return Response.json({ code: "request_invalid" }, { status: 400 }) }
  const parsed = ModelTestRequestSchema.safeParse(body)
  if (!parsed.success) return Response.json({ code: "request_invalid" }, { status: 400 })
  return Response.json(await modelProbe.test(parsed.data.model, parsed.data.input))
}
const MAX_BODY_BYTES = 2 * 1024 * 1024
const refuse = (outgoing: ServerResponse, status: number, code: string): void => {
  if (!outgoing.headersSent) outgoing.writeHead(status, { "content-type": "application/json", connection: "close" })
  outgoing.end(`${JSON.stringify({ status: "error", code })}\n`)
}
/** Buffers the request body, or resolves `undefined` once it exceeds the limit
 * without destroying the socket, so the caller still receives the refusal. */
const readBody = (incoming: IncomingMessage): Promise<Buffer<ArrayBuffer> | undefined> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const collect = (chunk: Buffer): void => {
      size += chunk.byteLength
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk)
        return
      }
      incoming.off("data", collect)
      resolve(undefined)
    }
    incoming.on("data", collect)
    incoming.once("end", () => resolve(Buffer.concat(chunks)))
    incoming.once("error", reject)
  })
/** A loopback caller that stalls its headers or body loses the socket instead
 * of holding it; the checks run every second so the bounds hold closely. */
const server = createServer({
  headersTimeout: 5_000,
  requestTimeout: 10_000,
  connectionsCheckingInterval: 1_000
}, async (incoming, outgoing) => {
  const abort = new AbortController()
  outgoing.on("close", () => {
    if (!outgoing.writableEnded) abort.abort()
  })
  try {
    const declared = Number(incoming.headers["content-length"] ?? "0")
    const bytes = declared > MAX_BODY_BYTES ? undefined : await readBody(incoming)
    if (bytes === undefined) {
      refuse(outgoing, 413, "request_invalid")
      return
    }
    const method = incoming.method ?? "GET"
    // A fixed origin: routing reads the request path, never the caller's Host header.
    const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
      method,
      headers: incoming.headers as HeadersInit,
      ...(method === "GET" || method === "HEAD" ? {} : { body: bytes }),
      signal: abort.signal
    })
    const response = new URL(request.url).pathname === "/v1/model/test" && method === "POST"
      ? await testModel(request)
      : await handle(request)
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch {
    refuse(outgoing, 500, "turn_failed")
  }
})
server.listen(port, parsed.values.host, () => {
  const address = server.address()
  const boundPort = typeof address === "object" && address !== null ? address.port : port
  process.stdout.write(
    `${JSON.stringify({ protocol: MODEL_HOST_PROTOCOL, host: parsed.values.host, port: boundPort })}\n`
  )
})
const stop = () => server.close(() => process.exit(0))
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
