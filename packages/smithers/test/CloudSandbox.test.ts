import { NodeServices } from "@effect/platform-node"
import * as CloudSandbox from "@smthrs/cli/CloudSandbox"
import { Sandbox } from "@smthrs/sandbox"
import { Effect, Exit, Fiber, FileSystem } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

// Fake control API permits deterministic provisioning, failure, and cancellation.
// Commands and file operations still cross the real CommandSandbox host boundary.
const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = (statuses = ["running"]) => {
  const workdir = mkdtempSync(join(tmpdir(), "cloud-sandbox-"))
  roots.push(workdir)
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  let grants = 0
  const api: CloudSandbox.WorkspaceApi = {
    request: async (method, path, body) => {
      requests.push({ method, path, body })
      if (method === "DELETE") return null
      if (method === "POST") return { id: "ws-123", status: "pending" }
      return { id: "ws-123", status: statuses.length > 1 ? statuses.shift() : statuses[0] }
    },
    sshPrefix: async (reference) => {
      expect(reference).toBe("acme/repo/ws-123")
      grants++
      return []
    }
  }
  const make = (overrides: Partial<CloudSandbox.Options> = {}) =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      return CloudSandbox.make({
        spawner,
        repository: "acme/repo",
        api,
        workdir,
        pollInterval: "1 millis",
        ...overrides
      })
    })
  return { api, make, requests, workdir, grants: () => grants }
}
const run = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

describe("CloudSandbox", () => {
  it("places commands and binary files on the acquired workspace, refreshes grants, then deletes it", async () => {
    const f = fixture(["pending", "provisioning", "running"])
    await run(Effect.gen(function*() {
      const provider = yield* f.make({ sourceBookmark: "main" })
      yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner
        const bytes = new Uint8Array([0, 255, 10, 128])
        yield* fs.writeFile(join(f.workdir, "bytes"), bytes)
        expect(yield* fs.readFile(join(f.workdir, "bytes"))).toEqual(bytes)
        expect(yield* spawner.string(ChildProcess.make("pwd"))).toBe(f.workdir + "\n")
        expect(f.requests.some((r) => r.method === "DELETE")).toBe(false)
      }).pipe(Effect.provide(Sandbox.layerHost(provider, { session: "issue:2924" })))
    }))
    expect(f.grants()).toBeGreaterThan(4)
    expect(f.requests.map((r) => r.method)).toEqual(["POST", "GET", "GET", "GET", "DELETE"])
    expect(f.requests[0]?.body).toEqual({
      name: expect.stringMatching(/^smthrs-[a-f0-9]{64}$/),
      source_bookmark: "main"
    })
    expect(f.requests.at(-1)?.path).toBe("/api/repos/acme/repo/workspaces/ws-123")
  })

  it("uses a stable distinct workspace name for each session and returns the Cloud id", async () => {
    const f = fixture()
    const ids = await run(Effect.gen(function*() {
      const provider = yield* f.make({ namePrefix: "burndown-" })
      const ids: Array<string> = []
      for (const key of ["run:one", "run:two", "run:one"]) {
        ids.push(yield* Effect.scoped(Effect.map(provider.acquire(key), (session) => session.remoteId)))
      }
      return ids
    }))
    expect(ids).toEqual(["ws-123", "ws-123", "ws-123"])
    const names = f.requests.filter((r) => r.method === "POST").map((r) => (r.body as { name: string }).name)
    expect(names[0]).toMatch(/^burndown-[a-f0-9]{64}$/)
    expect(names[0]).not.toBe(names[1])
    expect(names[0]).toBe(names[2])
    expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(3)
  })

  it.each(["failed", "error", "deleted"])("cleans up a workspace that becomes %s", async (state) => {
    const f = fixture([state])
    const result = await run(Effect.gen(function*() {
      const provider = yield* f.make()
      return yield* Effect.exit(Effect.scoped(provider.acquire("failure")))
    }))
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.requests.at(-1)?.method).toBe("DELETE")
    expect(f.grants()).toBe(0)
  })

  it("deletes on timeout while provisioning", async () => {
    const f = fixture(["pending"])
    await expect(run(Effect.gen(function*() {
      const provider = yield* f.make({ readyTimeout: "15 millis" })
      yield* Effect.scoped(provider.acquire("timeout"))
    }))).rejects.toThrow("did not become running")
    expect(f.requests.at(-1)?.method).toBe("DELETE")
  })

  it("cancels an in-flight status read and deletes the held workspace", async () => {
    const f = fixture()
    let started!: () => void
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    let aborted = false
    const request = f.api.request
    f.api.request = async (method, path, body, signal) => {
      if (method !== "GET") return request(method, path, body, signal)
      started()
      return new Promise((_, reject) =>
        signal!.addEventListener("abort", () => {
          aborted = true
          reject(new Error("cancelled"))
        }, { once: true })
      )
    }
    await run(Effect.gen(function*() {
      const provider = yield* f.make()
      const fiber = yield* Effect.forkChild(Effect.scoped(provider.acquire("interrupt")))
      yield* Effect.promise(() => reading)
      yield* Fiber.interrupt(fiber)
    }))
    expect(aborted).toBe(true)
    expect(f.requests.at(-1)?.method).toBe("DELETE")
  })

  it("deletes even when SSH session setup fails without exposing credentials", async () => {
    const f = fixture()
    f.api.sshPrefix = async () => {
      throw new Error("secret-do-not-print")
    }
    await expect(run(Effect.gen(function*() {
      const provider = yield* f.make()
      yield* Effect.scoped(provider.acquire("ssh-failure"))
    }))).rejects.toThrow("could not obtain workspace SSH access")
    expect(f.requests.at(-1)?.method).toBe("DELETE")
  })

  it("reports deletion failures instead of silently leaving the workspace", async () => {
    const f = fixture()
    const request = f.api.request
    f.api.request = async (method, path, body, signal) => {
      if (method === "DELETE") throw new Error("secret-do-not-print")
      return request(method, path, body, signal)
    }
    await expect(run(Effect.gen(function*() {
      const provider = yield* f.make()
      yield* Effect.scoped(provider.acquire("delete-failure"))
    }))).rejects.toThrow("could not delete workspace")
  })

  it("does not fetch SSH or delete another workspace when create fails", async () => {
    const f = fixture()
    f.api.request = async () => {
      throw new Error("secret-do-not-print")
    }
    await expect(run(Effect.gen(function*() {
      const provider = yield* f.make()
      yield* Effect.scoped(provider.acquire("create-failure"))
    }))).rejects.toThrow("could not create workspace")
    expect(f.grants()).toBe(0)
  })

  it.each(
    [
      { repository: "bad" },
      { workdir: "relative" },
      { workdir: "/bad\0" },
      { namePrefix: "spaces forbidden" },
      { namePrefix: "x".repeat(65) },
      { pollInterval: "0 millis" },
      { pollInterval: Infinity },
      { readyTimeout: "0 millis" },
      { readyTimeout: Infinity }
    ] satisfies Array<Partial<CloudSandbox.Options>>
  )("refuses invalid options before provisioning: %j", async (overrides) => {
    const f = fixture()
    await expect(run(f.make(overrides))).rejects.toThrow("cloud-sandbox:")
    expect(f.requests).toEqual([])
  })

  it("rejects an empty session before creation", async () => {
    const f = fixture()
    await expect(run(Effect.gen(function*() {
      const provider = yield* f.make()
      yield* Effect.scoped(provider.acquire("  "))
    }))).rejects.toThrow("session must not be empty")
    expect(f.requests).toEqual([])
  })

  it.each([null, {}, { id: "bad/id" }, { id: 3 }])("refuses a creation without a usable id: %j", async (response) => {
    const f = fixture()
    f.api.request = async () => response
    await expect(run(Effect.gen(function*() {
      const provider = yield* f.make()
      yield* Effect.scoped(provider.acquire("bad-create"))
    }))).rejects.toThrow("workspace creation response omitted a valid id")
    expect(f.grants()).toBe(0)
  })

  it.each([{ id: "another", status: "running" }, { id: "ws-123", status: "unknown" }, null])(
    "cleans up when a status read is malformed: %j",
    async (response) => {
      const f = fixture()
      const request = f.api.request
      f.api.request = async (method, path, body, signal) =>
        method === "GET" ? response : request(method, path, body, signal)
      await expect(run(Effect.gen(function*() {
        const provider = yield* f.make()
        yield* Effect.scoped(provider.acquire("bad-status"))
      }))).rejects.toThrow("workspace status response")
      expect(f.requests.at(-1)?.method).toBe("DELETE")
    }
  )

  it("cleans up when the control API refuses a status read", async () => {
    const f = fixture()
    const request = f.api.request
    f.api.request = async (method, path, body, signal) => {
      if (method === "GET") throw new Error("secret-do-not-print")
      return request(method, path, body, signal)
    }
    await expect(run(Effect.gen(function*() {
      const provider = yield* f.make()
      yield* Effect.scoped(provider.acquire("read-error"))
    }))).rejects.toThrow("could not read workspace status")
    expect(f.requests.at(-1)?.method).toBe("DELETE")
  })

  it("registers cleanup even if interrupted while workspace creation is admitted", async () => {
    const f = fixture()
    let admitted!: () => void
    let complete!: (value: unknown) => void
    const creating = new Promise<void>((resolve) => {
      admitted = resolve
    })
    const request = f.api.request
    f.api.request = async (method, path, body, signal) => {
      if (method !== "POST") return request(method, path, body, signal)
      admitted()
      return new Promise((resolve) => {
        complete = resolve
      })
    }
    await run(Effect.gen(function*() {
      const provider = yield* f.make()
      const fiber = yield* Effect.forkChild(Effect.scoped(provider.acquire("interrupt-create")))
      yield* Effect.promise(() => creating)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* Effect.yieldNow
      complete({ id: "ws-123", status: "pending" })
      yield* Fiber.join(interrupting)
    }))
    expect(f.requests.at(-1)?.method).toBe("DELETE")
    expect(f.grants()).toBe(0)
  })

  it("uses the shared signed-in API and workspace SSH endpoint, and deletes after an SSH refusal", async () => {
    const seen: Array<{ method: string; path: string; auth: string | undefined; body: unknown }> = []
    const server = createServer(async (request, response) => {
      let text = ""
      for await (const chunk of request) text += chunk
      seen.push({
        method: request.method!,
        path: request.url!,
        auth: request.headers.authorization,
        body: text ? JSON.parse(text) : null
      })
      const ssh = request.url!.endsWith("/ssh")
      response.writeHead(ssh ? 403 : 200, { "content-type": "application/json" })
      response.end(JSON.stringify(ssh ? { message: "denied" } : { id: "ws-default", status: "running" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      await expect(run(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const provider = CloudSandbox.make({
          spawner,
          repository: "acme/repo",
          environment: {
            HOME: fixture().workdir,
            XDG_CONFIG_HOME: fixture().workdir,
            SMITHERS_API_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            SMITHERS_TOKEN: "test-user-token"
          }
        })
        yield* Effect.scoped(provider.acquire("default"))
      }))).rejects.toThrow("could not obtain workspace SSH access")
      expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "POST /api/repos/acme/repo/workspaces",
        "GET /api/repos/acme/repo/workspaces/ws-default",
        "GET /api/repos/acme/repo/workspaces/ws-default/ssh",
        "DELETE /api/repos/acme/repo/workspaces/ws-default"
      ])
      expect(seen.every(({ auth }) => auth === "token test-user-token")).toBe(true)
      expect(seen[0]?.body).toEqual({ name: expect.stringMatching(/^smthrs-[a-f0-9]{64}$/) })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("interrupts shared SSH-readiness polling before deleting the workspace", async () => {
    let polled!: () => void
    const polling = new Promise<void>((resolve) => {
      polled = resolve
    })
    const methods: Array<string> = []
    const server = createServer((request, response) => {
      methods.push(`${request.method} ${request.url}`)
      const ssh = request.url!.endsWith("/ssh")
      response.writeHead(ssh ? 503 : 200, { "content-type": "application/json" })
      response.end(JSON.stringify(ssh ? {} : { id: "ws-default", status: "running" }))
      if (ssh) polled()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      await run(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const provider = CloudSandbox.make({
          spawner,
          repository: "acme/repo",
          environment: {
            HOME: fixture().workdir,
            XDG_CONFIG_HOME: fixture().workdir,
            SMITHERS_API_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            SMITHERS_TOKEN: "test-user-token",
            SMITHERS_WORKSPACE_SSH_POLL_INTERVAL_MS: "100000"
          }
        })
        const fiber = yield* Effect.forkChild(Effect.scoped(provider.acquire("poll-cancel")))
        yield* Effect.promise(() => polling)
        yield* Fiber.interrupt(fiber)
      }))
      expect(methods).toEqual([
        "POST /api/repos/acme/repo/workspaces",
        "GET /api/repos/acme/repo/workspaces/ws-default",
        "GET /api/repos/acme/repo/workspaces/ws-default/ssh",
        "DELETE /api/repos/acme/repo/workspaces/ws-default"
      ])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

it.skipIf(process.env.SMITHERS_CLOUD_SANDBOX_SMOKE !== "1")("CloudSandbox live workspace lifecycle", async () => {
  const repository = process.env.SMITHERS_CLOUD_SANDBOX_REPOSITORY
  expect(repository).toBeTruthy()
  await run(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const provider = CloudSandbox.make({ spawner, repository: repository!, environment: process.env })
    yield* Effect.gen(function*() {
      const remote = yield* ChildProcessSpawner
      expect((yield* remote.string(ChildProcess.make("pwd"))).trim()).toBe("/home/developer/workspace")
      const fs = yield* FileSystem.FileSystem
      const file = "/home/developer/workspace/.cloud-sandbox-smoke"
      const bytes = new Uint8Array([0, 255, 10, 128])
      yield* fs.writeFile(file, bytes)
      expect(yield* fs.readFile(file)).toEqual(bytes)
    }).pipe(Effect.provide(Sandbox.layerHost(provider, { session: `smoke:${Date.now()}` })))
  }))
}, 600_000)
