import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"
import { hostScript } from "./hostScript.ts"

const position = { path: "/workspace/a b.ts", line: 2, character: 4 }
const positionParams = { textDocument: { uri: "file:///workspace/a%20b.ts" }, position: { line: 2, character: 4 } }
const childScript = (prepared: unknown = [], malformedHeader?: string, rpcError?: unknown): string => `
const prepared = ${JSON.stringify(prepared)};
const malformedHeader = ${JSON.stringify(malformedHeader ?? null)};
let bytes = Buffer.alloc(0);
let damaged = false;
const rpcError = ${JSON.stringify(rpcError)};
const seen = [];
const send = (value) => {
 const body = Buffer.from(JSON.stringify(value));
 process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]));
};
process.stdin.on('data', (chunk) => {
 bytes = Buffer.concat([bytes, chunk]);
 while (true) {
  const split = bytes.indexOf('\\r\\n\\r\\n');
  if (split < 0) return;
  const length = Number(/Content-Length:\\s*(\\d+)/i.exec(bytes.subarray(0,split).toString())[1]);
  if (bytes.length < split + 4 + length) return;
  const request = JSON.parse(bytes.subarray(split+4,split+4+length).toString());
  bytes = bytes.subarray(split+4+length);
  seen.push(request.method);
  if (request.id === undefined) continue;
  if (request.method === 'initialize') { send({jsonrpc:'2.0',id:request.id,result:{capabilities:{}}}); continue; }
  if (malformedHeader !== null && !damaged) {
   damaged = true;
   process.stdout.write(malformedHeader);
   continue;
  }
  if (rpcError !== undefined && !damaged) { damaged = true; send({jsonrpc:'2.0',id:request.id,error:rpcError}); continue; }
  const result = request.method === 'textDocument/prepareCallHierarchy'
   ? prepared : {method:request.method,params:request.params,seen:[...seen]};
  send({jsonrpc:'2.0',id:request.id,result});
 }
});
`
const withServer = <A>(
  body: (server: LanguageServer.LanguageServer) => Effect.Effect<A, unknown>,
  prepared?: unknown,
  malformedHeader?: string,
  rpcError?: unknown
) =>
  Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const server = yield* NodeLanguageServer.make({
        command: process.execPath,
        args: [hostScript(childScript(prepared, malformedHeader, rpcError))],
        cwd: process.cwd()
      })
      return yield* body(server)
    })).pipe(Effect.provide(NodeServices.layer))
  )

describe("NodeLanguageServer real protocol boundaries", () => {
  it.each(
    [
      ["definition", "textDocument/definition", positionParams],
      ["references", "textDocument/references", { ...positionParams, context: { includeDeclaration: true } }],
      ["implementation", "textDocument/implementation", positionParams],
      ["documentSymbols", "textDocument/documentSymbol", { textDocument: { uri: "file:///workspace/a%20b.ts" } }],
      ["workspaceSymbols", "workspace/symbol", { query: "Widget" }],
      ["diagnostics", "textDocument/diagnostic", { textDocument: { uri: "file:///workspace/a%20b.ts" } }]
    ] as const
  )("forwards %s with its exact JSON-RPC method and parameters", async (operation, method, params) => {
    const result = await withServer((server) =>
      operation === "workspaceSymbols"
        ? server.workspaceSymbols("Widget")
        : operation === "documentSymbols" || operation === "diagnostics"
        ? server[operation](position.path)
        : server[operation](position)
    )
    expect(result).toEqual({ method, params, seen: ["initialize", "initialized", method] })
  })

  it.each(["callHierarchyIncoming", "callHierarchyOutgoing"] as const)(
    "%s prepares first and passes only the first returned item unchanged",
    async (operation) => {
      const first = { name: "first", uri: "file:///workspace/a.ts", data: { opaque: [1, "two"] } }
      const second = { name: "ignored", uri: "file:///workspace/b.ts" }
      const method = operation === "callHierarchyIncoming"
        ? "callHierarchy/incomingCalls"
        : "callHierarchy/outgoingCalls"
      const result = await withServer((server) => server[operation](position), [first, second])
      expect(result).toEqual({
        method,
        params: { item: first },
        seen: ["initialize", "initialized", "textDocument/prepareCallHierarchy", method]
      })
    }
  )

  it.each([[], null, { items: [{ name: "wrong wrapper" }] }] as const)(
    "does not issue a follow-up hierarchy call when preparation returns %j",
    async (prepared) => {
      const result = await withServer((server) =>
        Effect.gen(function*() {
          const incoming = yield* server.callHierarchyIncoming(position)
          const outgoing = yield* server.callHierarchyOutgoing(position)
          const receipt = yield* server.workspaceSymbols("receipt")
          return { incoming, outgoing, receipt }
        }), prepared)
      expect(result).toEqual({
        incoming: [],
        outgoing: [],
        receipt: {
          method: "workspace/symbol",
          params: { query: "receipt" },
          seen: [
            "initialize",
            "initialized",
            "textDocument/prepareCallHierarchy",
            "textDocument/prepareCallHierarchy",
            "workspace/symbol"
          ]
        }
      })
    }
  )

  it.each([
    ["X-Other: ignored\r\n\r\n", "Language server frame omitted Content-Length"],
    [`X-Padding: ${"x".repeat(8193)}\r\n\r\n`, "Language server frame header exceeded 8192 bytes"]
  ])("refuses a malformed complete header and resynchronizes the next request", async (header, message) => {
    const result = await withServer(
      (server) =>
        Effect.gen(function*() {
          const refused = yield* Effect.flip(server.hover(position))
          const recovered = yield* server.definition(position)
          return { refused, recovered }
        }),
      [],
      header
    )
    expect(result.refused).toMatchObject({ code: "request_failed", method: "textDocument/hover", message })
    expect(result.recovered).toEqual({
      method: "textDocument/definition",
      params: positionParams,
      seen: ["initialize", "initialized", "textDocument/hover", "textDocument/definition"]
    })
  })

  it.each(
    [
      [null, "Language server returned a JSON-RPC error"],
      [{ code: -32603 }, "Language server returned a JSON-RPC error"],
      [{ message: "Unavailable method" }, "Unavailable method"],
      [{ code: "untyped", message: "Unavailable method" }, "Unavailable method"]
    ] as const
  )("maps malformed error payload %j to a typed failure then accepts the next request", async (rpcError, message) => {
    const result = await withServer(
      (server) =>
        Effect.gen(function*() {
          const refused = yield* Effect.flip(server.hover(position))
          const recovered = yield* server.definition(position)
          return { refused, recovered }
        }),
      [],
      undefined,
      rpcError
    )
    expect(result.refused).toMatchObject({ code: "request_failed", method: "textDocument/hover", message })
    expect(result.refused.rpcError).toBeUndefined()
    expect(result.recovered).toEqual({
      method: "textDocument/definition",
      params: positionParams,
      seen: ["initialize", "initialized", "textDocument/hover", "textDocument/definition"]
    })
  })

  it("provides a real server through its public scoped layer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* LanguageServer.LanguageServer
        return yield* server.workspaceSymbols("layer")
      }).pipe(
        Effect.provide(
          NodeLanguageServer.layer({ command: process.execPath, args: [hostScript(childScript())], cwd: process.cwd() })
        ),
        Effect.provide(NodeServices.layer)
      )
    )
    expect(result).toEqual({
      method: "workspace/symbol",
      params: { query: "layer" },
      seen: ["initialize", "initialized", "workspace/symbol"]
    })
  })

  it("reports a genuinely missing server executable as provider unavailable", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(Effect.flip(NodeLanguageServer.make({
        command: `${process.execPath}.smithers-missing-language-server`,
        cwd: process.cwd()
      }))).pipe(Effect.provide(NodeServices.layer))
    )
    expect(error.code).toBe("provider_unavailable")
    expect(error.message).toMatch(/^Language server process could not be started: /)
  })
})
