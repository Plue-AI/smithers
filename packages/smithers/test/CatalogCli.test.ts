import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

import fixtureCases from "./CatalogCli.fixture.json" with { type: "json" }

// Reviewed literal argv and HTTP expectations; never generated from descriptors.
const cases = fixtureCases.requests

async function fixture(status = 200, response: unknown = { state: "accepted" }, headers: Record<string, string> = {}) {
  const seen: unknown[] = [], home = await mkdtemp(join(tmpdir(), "fr-t-cat-01-"))
  const idempotencyKeys: Array<string | string[] | undefined> = []
  const server = createServer((request, result) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      idempotencyKeys.push(request.headers["idempotency-key"])
      seen.push({
        method: request.method,
        path: request.url,
        body: body ? JSON.parse(body) : undefined,
        via: request.headers["smithers-via"]
      })
      result.writeHead(status, { "Content-Type": "application/json", ...headers })
      result.end(JSON.stringify(typeof response === "function" ? response(request.method) : response))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const environment = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_TOKEN: "test-delegated-token",
    CODEX_TEST: "1"
  }
  return {
    seen,
    idempotencyKeys,
    origin,
    async invoke(argv: string[]) {
      let stdout = "", exitCode = 0
      const cli = makeCli({
        environment,
        exit: (value) => {
          exitCode = value
        }
      })
      await cli.serve([...argv, "--json"], {
        env: environment,
        stdout: (text) => {
          stdout += text
        },
        exit: (value) => {
          exitCode = value
        }
      })
      return { stdout, exitCode }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(home, { recursive: true, force: true })
    }
  }
}

describe("C-CAT-02 installed parser and descriptor dispatcher", () => {
  it("audits the actual install discovery tree against literal Appendix A and B.6 paths", async () => {
    const { installCommandPaths } = await import("../src/internal/backend/InstallDiscovery.ts")
    const { auditCliPaths } = await import("../../../scripts/catalog-policy.ts")
    const paths = installCommandPaths(makeCli())
    expect(paths).toEqual([...fixtureCases.commands.map(row => row.path), ...fixtureCases.b6].sort())
    expect(auditCliPaths(paths)).toEqual([])
    expect(auditCliPaths([...paths, "history todo", "host invented"])).toEqual([
      { id: "history todo", reason: "unlisted" }, { id: "host invented", reason: "unlisted" }
    ])
    expect(() => installCommandPaths({})).toThrow("CLI install discovery is unavailable")
  })
  it("B.6 host doors resolve through the installed parser without executing maintenance", async () => {
    const f = await fixture()
    try {
      const paths = fixtureCases.b6.filter(path => path.startsWith("host "))
      expect(paths).toHaveLength(6)
      for (const path of paths) {
        const result = await f.invoke([...path.split(" "), "--schema"])
        expect(result.exitCode, result.stdout).toBe(0)
        const schema = JSON.parse(result.stdout)
        expect(schema.options.properties).toHaveProperty("verbose")
        if (path === "host restore") expect(schema.args.required).toEqual(["directory"])
        if (path === "host start") expect(Object.keys(schema.options.properties).sort()).toEqual(["bind", "bundle", "origin", "verbose"])
      }
      expect(f.seen).toEqual([])
    } finally { await f.close() }
  })
  it("the generated host reference is fresh and contains exactly the literal B.6 host paths", async () => {
    const { generateHostReference } = await import("../../../scripts/catalog-host.ts")
    const reference = await readFile(new URL("../docs/reference/cli/host.md", import.meta.url), "utf8")
    expect(reference).toBe(generateHostReference())
    expect([...reference.matchAll(/\| `smthrs (host [a-z]+)/g)].map(match => match[1]).sort())
      .toEqual(fixtureCases.b6.filter(path => path.startsWith("host ")).sort())
  })
  it("every external-agent command has a literal request or unavailable-provider case", () => {
    const argv = [...cases.map(row => row.argv), ...fixtureCases.unavailable]
    for (const command of fixtureCases.commands) {
      const words = command.path.split(" ")
      expect(argv.filter(args => words.every((word, index) => args[index] === word)), command.path).not.toHaveLength(0)
    }
  })
  it.each(fixtureCases.unavailable)("refuses unavailable providers without transport: %s", async (...argv) => {
    const f = await fixture()
    try {
      const result = await f.invoke(argv)
      expect(result.exitCode, result.stdout).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ code: "not_available" })
      expect(f.seen).toEqual([])
    } finally {
      await f.close()
    }
  })
  it.each([[], ["--operationId", "get_api_todos"], ["--intent", "send"], [
    "--intent",
    "confirm",
    "--confirmation",
    "stale"
  ]])("refuses raw API invocation before transport: %s", async (...args) => {
    const f = await fixture()
    try {
      const result = await f.invoke(["debug", "api", ...args])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ class: "never", code: "never" })
      expect(f.seen).toEqual([])
      expect(result.stdout).not.toContain("test-delegated-token")
    } finally {
      await f.close()
    }
  })
  it.each(cases)("dispatches literal $argv once", async (row) => {
    const f = await fixture()
    try {
      const result = await f.invoke(row.argv)
      expect(result.exitCode, result.stdout).toBe(0)
      expect(f.seen).toEqual([{ method: row.method, path: row.path, body: row.body, via: "codex" }])
    } finally {
      await f.close()
    }
  })
  it.each(["#1", "T0", "T-1", "T1/merge"])("rejects invalid TODO %s before dispatch", async (todo) => {
    const f = await fixture()
    try {
      expect((await f.invoke(["todo", "stop", todo])).exitCode).not.toBe(0)
      expect(f.seen).toEqual([])
    } finally {
      await f.close()
    }
  })
  it.each([["stack", "move", "T1", "sideways"], ["stack", "move", "T1"], ["todo", "steer", "T1"],
    ["issue", "show", "twelve"], ["flow", "run", "lint-fix", "--input", "not-json"],
    ["flow", "run", "lint-fix", "--input", "[]"], ["todo", "new", "--acceptance", "[1]"], ["todo", "new", "--before", "#1"], ["todo", "new", "--before", "T0"]])(
    "rejects invalid enum or missing required fields: %s",
    async (...argv) => {
      const f = await fixture()
      try {
        expect((await f.invoke(argv)).exitCode).not.toBe(0)
        expect(f.seen).toEqual([])
      } finally {
        await f.close()
      }
    }
  )
  it("publishes literal TODO and enum argument schemas", async () => {
    const f = await fixture()
    try {
      const result = await f.invoke(["stack", "move", "--schema"])
      const schema = JSON.parse(result.stdout)
      expect(schema.args.required).toEqual(["n", "direction"])
      expect(schema.args.properties.n).toMatchObject({ type: "string", pattern: "^T[1-9]\\d*$" })
      expect(schema.args.properties.direction).toMatchObject({ type: "string", enum: ["up", "down"] })
      expect(f.seen).toEqual([])
    } finally { await f.close() }
  })
  it("prints the server-bound person's name without a follow-up request", async () => {
    const f = await fixture(202, { confirmation: "confirm-1", state: "pending" }, { "Smithers-Confirmation-Person": "Ben%20Lee" })
    try {
      const result = await f.invoke(["todo", "new", "--text", "Retry"])
      expect(result.exitCode).toBe(3)
      expect(JSON.parse(result.stdout)).toEqual({ confirmation: "confirm-1", state: "pending", message: "Waiting for Ben Lee to confirm" })
      expect(f.seen).toHaveLength(1)
    } finally { await f.close() }
  })
  it.each([200, 201])("refuses a pending envelope without HTTP 202: %i", async status => {
    const f = await fixture(status, { confirmation: "confirm-1", state: "pending" })
    try {
      const result = await f.invoke(["todo", "new", "--text", "Retry"])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ code: "backend_protocol" })
      expect(result.stdout).not.toContain("Waiting for")
      expect(f.seen).toHaveLength(1)
    } finally { await f.close() }
  })
  it("keeps an S1 requested outcome distinct from ordinary confirmation", async () => {
    const f = await fixture(202, { todo: 1, state: "requested" })
    try {
      const result = await f.invoke(["todo", "new", "--text", "Retry"])
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ todo: 1, state: "requested" })
      expect(result.stdout).not.toContain("Waiting for")
      expect(f.seen).toHaveLength(1)
    } finally { await f.close() }
  })
  it.each([
    { state: "pending" },
    { state: "pending", confirmation: null },
    { state: "pending", confirmation: "" },
    { state: "pending", confirmation: "   " },
    { state: "pending", confirmation: 12 },
    { confirmation: "confirm-1" },
    { state: "requested", confirmation: "confirm-1" },
    { state: "completed", confirmation: "confirm-1" }
  ])("refuses malformed confirmation metadata without claiming success: %j", async receipt => {
    const f = await fixture(202, receipt)
    try {
      const result = await f.invoke(["todo", "new", "--text", "Retry"])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ code: "backend_protocol" })
      expect(result.stdout).not.toContain("Waiting for")
      expect(f.seen).toHaveLength(1)
    } finally { await f.close() }
  })
  it("uses the supplied request identity for retried TODO creation", async () => {
    const f = await fixture()
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await f.invoke(["todo", "new", "--text", "Retry", "--idempotencyKey", "stable-create"])).exitCode).toBe(0)
      }
      expect(f.idempotencyKeys).toEqual(["stable-create", "stable-create"])
    } finally { await f.close() }
  })
  it("preserves a supplied steering identity across retries without sending it as feedback", async () => {
    const f = await fixture()
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await f.invoke(["todo", "steer", "T1", "Use retries", "--idempotencyKey", "stable-steer"])).exitCode).toBe(0)
      }
      expect(f.idempotencyKeys).toEqual(["stable-steer", "stable-steer"])
      expect(f.seen).toEqual([0, 1].map(() => ({ method: "POST", path: "/api/todos/1", body: { steer: "Use retries" }, via: "codex" })))
    } finally { await f.close() }
  })
  it("retains pending identity and uses an exit distinct from success or refusal", async () => {
    const f = await fixture(202, { confirmation: "confirm-1", state: "pending" })
    try {
      const result = await f.invoke(["merge", "T1", "--reviewed_head_sha", "a".repeat(40)])
      expect(result.exitCode).toBe(3)
      expect(JSON.parse(result.stdout)).toMatchObject({ confirmation: "confirm-1", state: "pending" })
      expect(f.seen).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
  it.each(
    [[403, "never", "never"], [403, "permission", "permission"], [401, "permission", "unauthenticated"], [
      503,
      "infra",
      "confirmation_unavailable"
    ]] as const
  )("preserves %i %s/%s", async (status, fault, code) => {
    const f = await fixture(status, { class: fault, code, message: "Refused" })
    try {
      const result = await f.invoke(["todo", "stop", "T1"])
      expect(result.exitCode).not.toBe(0)
      expect(result.exitCode).not.toBe(3)
      expect(JSON.parse(result.stdout)).toMatchObject({ class: fault, code })
      expect(result.stdout).not.toContain("\"pending\"")
      expect(f.seen).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
})

describe("person card CLI doors", () => {
  it.each(["settings", "members", "secrets"])(
    "opens %s without an HTTP mutation or a credential in the URL",
    async (name) => {
      const root = await mkdtemp(join(tmpdir(), "fr-t-cat-01-card-"))
      const bin = join(root, "bin"), receipt = join(root, "opened")
      await mkdir(bin)
      await writeFile(
        join(bin, process.platform === "darwin" ? "open" : "xdg-open"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > "$CARD_RECEIPT"\n`,
        { mode: 0o755 }
      )
      const f = await fixture()
      try {
        const environment = {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          SMITHERS_API_ORIGIN: f.origin,
          SMITHERS_TOKEN: "PRIVATE_TOKEN",
          PATH: bin,
          CARD_RECEIPT: receipt
        }
        let stdout = "", code = 0
        await makeCli({
          environment,
          exit: (value) => {
            code = value
          }
        }).serve([name, "--json"], {
          env: environment,
          stdout: (text) => {
            stdout += text
          },
          exit: (value) => {
            code = value
          }
        })
        expect(code, stdout).toBe(0)
        expect(await readFile(receipt, "utf8")).toBe(`${f.origin}/?card=${name}\n`)
        expect(f.seen).toEqual([])
        expect(stdout).not.toContain("PRIVATE_TOKEN")
      } finally {
        await f.close()
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

describe("shared catalog HTTP encoding", () => {
  it("maps optional nested bodies without mutating descriptor defaults across requests", async () => {
    const { catalogRequest } = await import("../src/CatalogRequest.ts")
    const descriptor = { http: { method: "POST" as const, path: "/api/todos", body: { prompt: "text" },
      defaults: { place: { mode: "append" } }, objects: { place: { when: "before", body: { n: "before" }, defaults: { mode: "before" } } } } }
    const first = catalogRequest(descriptor, { text: "A" })
    expect(first.body).toEqual({ prompt: "A", place: { mode: "append" } })
    ;(first.body!.place as Record<string, unknown>).mode = "changed"
    expect(catalogRequest(descriptor, { text: "B", before: null }).body).toEqual({ prompt: "B", place: { mode: "append" } })
    expect(catalogRequest(descriptor, { text: "C", before: 2 }).body).toEqual({ prompt: "C", place: { mode: "before", n: 2 } })
    expect(catalogRequest(descriptor, { before: 0 }).body).toEqual({ place: { mode: "before", n: 0 } })
    expect(descriptor.http.defaults).toEqual({ place: { mode: "append" } })
  })
  it("maps body fields, fixes operation defaults, and leaves input untouched", async () => {
    const { catalogRequest } = await import("../src/CatalogRequest.ts")
    const payload = Object.freeze({ n: 3, text: "Use backoff", op: "forged", unused: "private" })
    expect(catalogRequest({
      http: {
        method: "POST",
        path: "/api/todos/{n}",
        body: { steer: "text", op: "op", missing: "absent" },
        defaults: { op: "steer" }
      }
    }, payload)).toEqual({ method: "POST", path: "/api/todos/3", body: { steer: "Use backoff", op: "steer" } })
    expect(payload).toEqual({ n: 3, text: "Use backoff", op: "forged", unused: "private" })
  })
  it("encodes path segments and preserves false and zero in inferred query fields", async () => {
    const { catalogRequest } = await import("../src/CatalogRequest.ts")
    expect(catalogRequest({ http: { method: "GET", path: "/api/things/{id}" } }, {
      id: "雪/a?b#c",
      page: 0,
      active: false,
      absent: undefined
    })).toEqual({ method: "GET", path: "/api/things/%E9%9B%AA%2Fa%3Fb%23c?page=0&active=false" })
  })
  it("honors explicit query mappings and excludes unrelated fields", async () => {
    const { catalogRequest } = await import("../src/CatalogRequest.ts")
    expect(catalogRequest({
      http: {
        method: "GET",
        path: "/api/search/code",
        query: { q: "text", missing: "absent" }
      }
    }, { text: "Use backoff", private: "secret" })).toEqual({ method: "GET", path: "/api/search/code?q=Use+backoff" })
  })
  it("uses mapped and defaulted values when inferring a GET query", async () => {
    const { catalogRequest } = await import("../src/CatalogRequest.ts")
    expect(catalogRequest({
      http: {
        method: "GET",
        path: "/api/things/{id}",
        body: { q: "text" },
        defaults: { limit: 10 }
      }
    }, { id: 4, text: "x" })).toEqual({ method: "GET", path: "/api/things/4?q=x&limit=10" })
  })
  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("removes interpolated keys from %s bodies", async (method) => {
    const { catalogRequest } = await import("../src/CatalogRequest.ts")
    expect(catalogRequest({ http: { method, path: "/api/things/{id}" } }, { id: "a" }))
      .toEqual({ method, path: "/api/things/a", body: {} })
  })
  it("refuses unavailable bindings", async () => {
    const { catalogRequest } = await import("../src/CatalogRequest.ts")
    expect(() => catalogRequest({ http: null }, {})).toThrow("Command HTTP binding is unavailable")
  })
  it.each([
    "https://foreign/api/x",
    "//foreign/api/x",
    "/api/x?extra",
    "/api/x#fragment",
    "/api/../admin",
    "/api/{",
    "/api/\\admin"
  ])(
    "refuses invalid binding %s",
    async (path) => {
      const { catalogRequest } = await import("../src/CatalogRequest.ts")
      expect(() => catalogRequest({ http: { method: "GET", path } }, {})).toThrow("Invalid command HTTP binding")
    }
  )
  it.each([undefined, null, {}, [], "", ".", ".."])("refuses missing or path-normalizing values: %s", async (id) => {
    const { catalogRequest } = await import("../src/CatalogRequest.ts")
    expect(() => catalogRequest({ http: { method: "GET", path: "/api/things/{id}" } }, { id })).toThrow(
      /Invalid id|Missing or invalid id/
    )
  })
  it("refuses methods outside the catalog HTTP contract", async () => {
    const { catalogRequest } = await import("../src/CatalogRequest.ts")
    expect(() => catalogRequest({ http: { method: "TRACE" as "GET", path: "/api/x" } }, {}))
      .toThrow("Invalid command HTTP binding")
  })
})

describe("catalog answer transport", () => {
  it("resolves a single question then posts once with an idempotency key", async () => {
    const f = await fixture(200, (method: string) =>
      method === "GET"
        ? { waits: [{ kind: "confirmation", id: "ignore" }, { kind: "question", id: "question-1" }] }
        : { state: "accepted" })
    try {
      const result = await f.invoke(["todo", "answer", "T3", "Use retries"])
      expect(result.exitCode, result.stdout).toBe(0)
      expect(f.seen).toEqual([
        { method: "GET", path: "/api/todos/3", body: undefined, via: "codex" },
        {
          method: "POST",
          path: "/api/todos/3/answer",
          body: { answer: "Use retries", wait: "question-1" },
          via: "codex"
        }
      ])
      expect(f.idempotencyKeys[0]).toBeUndefined()
      expect(f.idempotencyKeys[1]).toMatch(/^[0-9a-f-]{36}$/)
      expect(JSON.parse(result.stdout)).toMatchObject({ todo: 3, wait: "question-1", state: "accepted" })
    } finally {
      await f.close()
    }
  })
  it("uses an explicit question without a preliminary read", async () => {
    const f = await fixture()
    try {
      const result = await f.invoke(["todo", "answer", "T3", "Use retries", "--wait", "question-2"])
      expect(result.exitCode, result.stdout).toBe(0)
      expect(f.seen).toEqual([
        {
          method: "POST",
          path: "/api/todos/3/answer",
          body: { answer: "Use retries", wait: "question-2" },
          via: "codex"
        }
      ])
      expect(f.idempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      await f.close()
    }
  })
  it.each([
    { waits: [], code: "no_question" },
    { waits: [{ kind: "question", id: "q1" }, { kind: "question", id: "q2" }], code: "several_questions" }
  ])("refuses $code without posting an answer", async ({ waits, code }) => {
    const f = await fixture(200, { waits })
    try {
      const result = await f.invoke(["todo", "answer", "T3", "Use retries"])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ code })
      expect(f.seen).toEqual([{ method: "GET", path: "/api/todos/3", body: undefined, via: "codex" }])
    } finally {
      await f.close()
    }
  })
  it("does not post when reading the question fails", async () => {
    const f = await fixture(503, { class: "infra", code: "unavailable", message: "Unavailable" })
    try {
      const result = await f.invoke(["todo", "answer", "T3", "Use retries"])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ code: "unavailable" })
      expect(f.seen).toEqual([{ method: "GET", path: "/api/todos/3", body: undefined, via: "codex" }])
    } finally {
      await f.close()
    }
  })
})
