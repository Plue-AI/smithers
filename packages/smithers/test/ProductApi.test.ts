import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import * as ProductApi from "../src/internal/backend/ProductApi.ts"

interface Parameter {
  readonly name: string
  readonly in: string
  readonly required?: boolean
  readonly schema?: { readonly type?: string | ReadonlyArray<string> }
}
interface Operation {
  readonly operationId: string
  readonly parameters?: ReadonlyArray<Parameter>
  readonly requestBody?: { readonly required?: boolean; readonly content?: Record<string, unknown> }
  readonly responses?: Record<string, { readonly $ref?: string; readonly content?: Record<string, unknown> }>
}

const spec = parse(readFileSync(new URL("../../../docs/api/openapi.yaml", import.meta.url), "utf8")) as {
  readonly paths: Record<string, Record<string, Operation>>
  readonly components: { readonly responses: Record<string, { readonly content?: Record<string, unknown> }> }
}
const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

/** The spec's operations as the generated client should call them. */
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  methods.filter((method) => item[method] !== undefined).map((method) => ({ path, method, operation: item[method]! }))
)

const functionName = (id: string) =>
  id.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word, index) =>
    index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join("")

const success = (operation: Operation): "json" | "raw" | "none" => {
  let kind: "json" | "raw" | "none" = "none"
  for (const [code, declared] of Object.entries(operation.responses ?? {})) {
    if (!code.startsWith("2")) continue
    const response = declared.$ref ? spec.components.responses[declared.$ref.split("/").at(-1)!]! : declared
    const types = Object.keys(response.content ?? {})
    if (types.includes("application/json")) kind = "json"
    else if (types.length > 0) kind = "raw"
  }
  return kind
}

const jsonBody = (operation: Operation) =>
  operation.requestBody !== undefined && Object.keys(operation.requestBody.content ?? {}).includes("application/json")

/** A value for `parameter` that needs escaping when it is a string. */
const sample = (parameter: Parameter) => {
  const types = [parameter.schema?.type ?? []].flat()
  if (types.includes("integer") || types.includes("number")) return 7
  if (types.includes("boolean")) return true
  return `a b/${parameter.name}?#%`
}

type Call = { readonly via: "request" | "response"; readonly args: ReadonlyArray<unknown> }

const recorder = () => {
  const calls: Array<Call> = []
  const answer = { answered: true }
  const raw = new Response("stream")
  const transport: ProductApi.Transport = {
    request: (...args: Array<unknown>) => {
      calls.push({ via: "request", args })
      return Promise.resolve(answer)
    },
    response: (...args: Array<unknown>) => {
      calls.push({ via: "response", args })
      return Promise.resolve(raw)
    }
  }
  return { calls, transport, answer, raw }
}

const generated = ProductApi as unknown as Record<
  string,
  (transport: ProductApi.Transport, input?: unknown) => Promise<unknown>
>

describe("the generated product API client", () => {
  it("exports one function per operation with a JSON or empty request body, and nothing else", () => {
    const expected = operations
      .filter(({ operation }) => operation.requestBody === undefined || jsonBody(operation))
      .map(({ operation }) => functionName(operation.operationId))
      .sort()
    const exported = Object.entries(ProductApi).filter(([, value]) => typeof value === "function").map(([name]) => name)
      .sort()
    expect(exported).toEqual(expected)
    // Reviewed deployed resource inventory (2026-10-05, smithers-b8): the members roster (#3491), the TODO
    // edit and answer routes, and the dark TODO branch diff (#3452) were added; the unserved branch reads
    // (fc5676df0, #3565) and the mythical config setter (44b074f80, #3572) were removed. The flow catalog
    // read, GET /api/flows (#3499), was added. The install issue reads, GET /api/issues and
    // GET /api/issues/{n} (#3457), were added.
    // Exact parity above and the literal resource inventory below remain independent.
    expect(expected).toHaveLength(507)
    expect(spec.paths).not.toHaveProperty("/api/repository-setup/{operation}")
    expect(operations.filter(({ path }) => path.startsWith("/api/install")).map(({ path, method }) =>
      `${method.toUpperCase()} ${path}`
    ).sort()).toEqual([
      // T-INS-06 setup steps in §16.2 order (9e9493943, #3455) plus the install read/write, scorecard and quiesce.
      "DELETE /api/install/quiesce", "GET /api/install", "GET /api/install/scorecard", "POST /api/install/quiesce",
      "POST /api/install/setup/address", "POST /api/install/setup/app", "POST /api/install/setup/machine",
      "POST /api/install/setup/models", "POST /api/install/setup/repository", "POST /api/install/setup/sign_in",
      "POST /api/install/setup/source", "PUT /api/install"
    ])
    for (const path of Object.keys(spec.paths)) {
      expect(path).not.toMatch(/^\/api\/(?:pair-sessions|share|oauth2\/applications)(?:\/|$)/)
    }
  })

  it.each(operations.filter(({ operation }) => operation.requestBody === undefined || jsonBody(operation)))(
    "$method $path sends the declared method, escaped path, query and body",
    async ({ path, method, operation }) => {
      const parameters = operation.parameters ?? []
      const pathValues = Object.fromEntries(parameters.filter((p) => p.in === "path").map((p) => [p.name, sample(p)]))
      const queryValues = Object.fromEntries(parameters.filter((p) => p.in === "query").map((p) => [p.name, sample(p)]))
      // Only a required header is the caller's; the transport owns the rest.
      const headers = Object.fromEntries(parameters.filter((p) => p.in === "header" && p.required === true).map((p) => [p.name, `key ${p.name}`]))
      const sendsHeaders = Object.keys(headers).length > 0
      const body = { operation: operation.operationId }
      const input = {
        ...(Object.keys(pathValues).length > 0 ? { path: pathValues } : {}),
        ...(Object.keys(queryValues).length > 0 ? { query: queryValues } : {}),
        ...(sendsHeaders ? { headers } : {}),
        ...(jsonBody(operation) ? { body } : {})
      }
      const { calls, transport, answer, raw } = recorder()
      const result = await generated[functionName(operation.operationId)]!(transport, input)

      const search = new URLSearchParams(Object.entries(queryValues).map(([key, value]) => [key, String(value)]))
      const expectedPath =
        path.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(String(pathValues[name]))) +
        (search.size > 0 ? `?${search}` : "")
      const kind = success(operation)
      expect(calls).toEqual([{
        via: kind === "raw" ? "response" : "request",
        args: [
          method.toUpperCase(),
          expectedPath,
          ...(jsonBody(operation) ? [body] : sendsHeaders ? [undefined] : []),
          ...(sendsHeaders ? [{ headers }] : [])
        ]
      }])
      expect(result).toBe(kind === "raw" ? raw : kind === "json" ? answer : undefined)
    }
  )

  it("leaves unset query parameters out of the path", async () => {
    const { calls, transport } = recorder()
    const path = { owner: "o", repo: "r", change_id: "c" }
    await ProductApi.getApiReposOwnerRepoChangesChangeIdDiff(transport, { path, query: { whitespace: "ignore" } })
    await ProductApi.getApiReposOwnerRepoChangesChangeIdDiff(transport, { path })
    expect(calls.map((call) => call.args[1])).toEqual([
      "/api/repos/o/r/changes/c/diff?whitespace=ignore",
      "/api/repos/o/r/changes/c/diff"
    ])
  })

  it("rejects when the transport rejects", async () => {
    const failure = new Error("refused")
    const transport: ProductApi.Transport = {
      request: () => Promise.reject(failure),
      response: () => Promise.reject(failure)
    }
    await expect(ProductApi.getApiUserKeys(transport)).rejects.toBe(failure)
    await expect(ProductApi.deleteApiUserKeysId(transport, { path: { id: 4 } })).rejects.toBe(failure)
    await expect(ProductApi.getApiAdminAuditLogs(transport)).rejects.toBe(failure)
  })
})
