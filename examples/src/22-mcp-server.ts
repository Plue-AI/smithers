/**
 * The MCP server `22-mcp-tools.ts` connects to.
 *
 * It is a separate process on purpose: an MCP session is a subprocess speaking
 * newline-delimited JSON-RPC over stdio, and an in-process double would prove
 * nothing about the transport, the handshake, or the framing. Nothing here
 * imports from this repository, because the point of the protocol is that the
 * server on the other end need not be ours.
 *
 * Usage: `node 22-mcp-server.ts`. It answers `initialize`, `tools/list`, and
 * `tools/call` and exits when its standard input closes.
 */
import { createInterface } from "node:readline"

const PROTOCOL_VERSION = "2025-06-18"

interface Request {
  readonly id?: number | string
  readonly method: string
  readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown> }
}

const tools = [
  {
    name: "word_count",
    description: "Counts the words in a piece of text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"]
    }
  },
  {
    name: "slugify",
    description: "Turns a title into a url slug",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"]
    }
  },
  {
    name: "explode",
    description: "Always reports a tool-level failure",
    inputSchema: { type: "object", properties: {} }
  }
]

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const text = (value: string, isError = false) => ({
  content: [{ type: "text", text: value }],
  isError
})

const call = (name: string | undefined, args: Record<string, unknown>) => {
  const subject = typeof args.text === "string" ? args.text : ""
  if (name === "word_count") {
    return text(String(subject.split(/\s+/u).filter((word) => word.length > 0).length))
  }
  if (name === "slugify") {
    return text(subject.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, ""))
  }
  return text("the tool refused", true)
}

createInterface({ input: process.stdin }).on("line", (line: string) => {
  let request: Request
  try {
    request = JSON.parse(line) as Request
  } catch {
    // A malformed line is answered, not thrown: JSON-RPC's parse error.
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    return
  }
  if (typeof request !== "object" || request === null || typeof request.method !== "string") {
    send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } })
    return
  }
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "examples-fixture", version: "1.0.0" }
      }
    })
    return
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools } })
    return
  }
  if (request.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: call(request.params?.name, request.params?.arguments ?? {})
    })
    return
  }
  // A notification carries no id and expects no reply.
  if (request.id !== undefined) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `no method ${request.method}` } })
  }
})
