import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

// Literal requests are independent of descriptors and generated artifacts.
const cases = [
  {
    argv: ["todo", "steer", "T1", "Use backoff"],
    method: "POST",
    path: "/api/todos/1",
    body: { steer: "Use backoff" }
  },
  { argv: ["todo", "stop", "T1"], method: "POST", path: "/api/todos/1", body: { op: "stop" } },
  { argv: ["todo", "resume", "T1"], method: "POST", path: "/api/todos/1", body: { op: "resume" } },
  { argv: ["todo", "show", "T1"], method: "GET", path: "/api/todos/1", body: undefined },
  {
    argv: ["todo", "new", "--text", "Add retry", "--title", "Retry"],
    method: "POST",
    path: "/api/todos",
    body: { prompt: "Add retry", title: "Retry", place: { mode: "append" } }
  },
  {
    argv: ["merge", "T1", "--reviewed_head_sha", "a".repeat(40)],
    method: "POST",
    path: "/api/todos/1/merge",
    body: { reviewed_head_sha: "a".repeat(40) }
  },
  {
    argv: ["search", "--query", "retry webhook"],
    method: "GET",
    path: "/api/search/code?q=retry+webhook",
    body: undefined
  },
  { argv: ["stack", "move", "T1", "up"], method: "POST", path: "/api/todos/1", body: { direction: "up", op: "move" } },
  { argv: ["github"], method: "GET", path: "/api/github/sync", body: undefined }
]

async function fixture(status = 200, response: unknown = { state: "accepted" }) {
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
      result.writeHead(status, { "Content-Type": "application/json" })
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
  it.each([["stack", "move", "T1", "sideways"], ["stack", "move", "T1"], ["todo", "steer", "T1"]])(
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
