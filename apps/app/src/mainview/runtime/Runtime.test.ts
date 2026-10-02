import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { APP_BOOTSTRAP_PATH } from "@smthrs/rpc/AppBootstrap"
import { BootstrapFailure, createRuntime, loadBootstrap, unavailableAgent } from "./Runtime"

const cloud: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "1",
  buildSha: "abc",
  capabilities: ["agent", "identity", "cloud"],
  authFlow: "redirect",
  sandbox: null
}

describe("runtime composition", () => {
  test("constructs ports from the validated host contract", async () => {
    const requests: Array<string> = []
    const runtime = createRuntime({
      bootstrap: cloud,
      http: async (input) => {
        requests.push(input.toString())
        return new Response(null, { status: 204 })
      }
    })
    expect(runtime.backend.agent?.available).toBe(true)
    // Only ports a consumer holds: identity and cloud are capabilities the
    // reading site tests through hasCapability, not descriptors mirrored here.
    expect(Object.keys(runtime.backend)).toEqual(["agent"])
    expect(runtime.bootstrap.capabilities).toContain("identity")
    expect(runtime.shell.kind).toBe("browser")
    if (runtime.backend.agent === undefined) throw new Error("Agent capability did not compose its port")
    await runtime.backend.agent.cancelTurn("run")
    expect(requests).toContain("/api/agent/turn/cancel")
  })

  test("local offline exposes only actual local ports", () => {
    const runtime = createRuntime({
      bootstrap: {
        ...cloud,
        host: "local",
        capabilities: [],
        authFlow: "none",
        sandbox: { platform: "linux", mode: "trusted-only" }
      },
      http: async () => new Response(null, { status: 204 })
    })
    expect(runtime.backend.agent).toBeUndefined()
    expect(Object.keys(runtime.backend)).toEqual([])
    expect(runtime.bootstrap.capabilities).not.toContain("identity")
    // The sandbox descriptor stays on the validated bootstrap, where the
    // product reads it (state/Onboarding.ts).
    expect(runtime.bootstrap.sandbox?.mode).toBe("trusted-only")
  })

  test("loads and validates the bootstrap endpoint", async () => {
    const seen: Array<string> = []
    const loaded = await loadBootstrap(async (input) => {
      seen.push(input.toString())
      return Response.json(cloud)
    })
    expect(seen).toEqual([APP_BOOTSTRAP_PATH])
    expect(loaded).toEqual(cloud)
  })

  test("a newer backend's workspace capabilities still boot the app and compose known ports", async () => {
    const bootstrap = await loadBootstrap(async () => Response.json({
      ...cloud, capabilities: ["workspace", "agent", "workspace.runtime", "identity", "workspace.deploy", "cloud"]
    }))
    const runtime = createRuntime({ bootstrap, http: async () => new Response(null, { status: 204 }) })
    expect(bootstrap.capabilities).toEqual(cloud.capabilities)
    expect(runtime.backend.agent?.available).toBe(true)
    expect(runtime.shell.kind).toBe("browser")
  })

  test.each([null, 1, false, {}, []].map(row => [row]))("a malformed capability row %j remains an invalid bootstrap", async row => {
    await expect(loadBootstrap(async () => Response.json({ ...cloud, capabilities: ["agent", row] })))
      .rejects.toMatchObject({ _tag: "BootstrapFailure", kind: "invalid" })
  })
})

for (const [label, response, kind] of [
  ["missing endpoint", new Response("404", { status: 404 }), "missing"],
  ["backend failure", new Response("oops", { status: 503 }), "server"],
  ["invalid document", Response.json({ apiVersion: 1 }), "invalid"]
] as const) {
  test(`classifies ${label} at the real bootstrap read`, async () => {
    await expect(loadBootstrap(async () => response)).rejects.toMatchObject({ kind })
  })
}

test("classifies an unreachable backend at the real bootstrap read", async () => {
  await expect(loadBootstrap(async () => { throw new TypeError("Failed to fetch") })).rejects.toBeInstanceOf(BootstrapFailure)
  const error = await loadBootstrap(async () => { throw new TypeError("Failed to fetch") }).catch((caught: unknown) => caught)
  expect(error).toMatchObject({ _tag: "BootstrapFailure", kind: "unreachable", message: "Backend is unreachable." })
  expect(error).not.toHaveProperty("status")
})

// The cache belongs to one document. This child owns that whole lifetime; no reset seam is added.
test("bootstrap warming shares the in-flight promise and retries after rejection", () => {
  const child = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict"
    import { warmBootstrap } from "./src/mainview/runtime/Runtime"
    const bootstrap = ${JSON.stringify(cloud)}
    const first = Promise.withResolvers()
    let reads = 0
    const http = () => { reads++; return first.promise }
    const pending = warmBootstrap(http)
    assert.equal(warmBootstrap(http), pending)
    assert.equal(reads, 1)
    first.reject(new Error("offline"))
    await assert.rejects(pending, { _tag: "BootstrapFailure", kind: "unreachable", message: "Backend is unreachable." })
    const invalid = warmBootstrap(() => { reads++; return Promise.resolve(new Response("not-json")) })
    assert.notEqual(invalid, pending)
    await assert.rejects(invalid, { kind: "invalid" })
    const next = Promise.withResolvers()
    const retry = warmBootstrap(() => { reads++; return next.promise })
    assert.notEqual(retry, invalid)
    assert.equal(warmBootstrap(http), retry)
    assert.equal(reads, 3)
    next.resolve(Response.json(bootstrap))
    assert.deepEqual(await retry, bootstrap)
    assert.equal(warmBootstrap(() => { throw new Error("successful cache was discarded") }), retry)
    assert.equal(reads, 3)
    console.log("owned bootstrap cache controls passed")
  `], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", timeout: 5000 })
  expect({ status: child.status, signal: child.signal, error: child.error, stderr: child.stderr }).toEqual({ status: 0, signal: null, error: undefined, stderr: "" })
  expect(child.stdout.trim()).toBe("owned bootstrap cache controls passed")
})

for (const [capabilities, available] of [
  [[], undefined], [["agent"], true], [["model.turn"], false], [["agent", "model.turn"], true]
] as const) test(`runtime agent port for capabilities ${capabilities.join(",") || "none"}`, () => {
  const bootstrap: AppBootstrap = { ...cloud, capabilities: [...capabilities] }
  const http = async () => { throw new Error("Composition must not call HTTP") }
  const runtime = createRuntime({ bootstrap, http })
  expect(runtime.bootstrap).toBe(bootstrap)
  expect(runtime.http).toBe(http)
  expect(runtime.backend.agent?.available).toBe(available)
  expect(Object.keys(runtime.backend)).toEqual(available === undefined ? [] : ["agent"])
  // Only the shared backend keeps turn journals; a model-only host's turns stream frames.
  expect(runtime.backend.agent?.journal !== undefined).toBe(available === true)
})

test("native shell retains and invokes the exact host callback", async () => {
  const calls: string[] = []
  const openExternal = async (url: string) => { calls.push(url); return false }
  const runtime = createRuntime({ bootstrap: cloud, http: async () => new Response(null, { status: 204 }), nativeOpenExternal: openExternal })
  expect(runtime.shell.kind).toBe("native")
  if (runtime.shell.kind !== "native") throw new Error("Native shell was not composed")
  expect(runtime.shell.openExternal).toBe(openExternal)
  expect(await runtime.shell.openExternal("https://example.test/settings")).toBe(false)
  expect(calls).toEqual(["https://example.test/settings"])
})

test("the unavailable adapter remains callable without emitting or retaining listeners", async () => {
  const first = unavailableAgent(), second = unavailableAgent()
  let deliveries = 0
  const unsubscribe = first.subscribe(() => { deliveries++ })
  expect(first.available).toBe(false)
  expect(first).not.toBe(second)
  expect(await first.startTurn({ runId: "owned-run", messages: [], instructions: "No provider" })).toEqual({ status: "error", message: "No agent provider is available in this runtime." })
  await first.cancelTurn("owned-run")
  unsubscribe()
  unsubscribe()
  expect(deliveries).toBe(0)
  expect(first.journal).toBeUndefined()
  expect(first.steer).toBeUndefined()
})

for (const [status, kind, message] of [
  [401, "server", "Backend could not start Smithers."], [404, "missing", "Backend does not provide Smithers bootstrap."], [500, "server", "Backend could not start Smithers."]
] as const) test(`bootstrap HTTP ${status} reports exact boundary failure fields`, async () => {
  const calls: Array<{ path: string; accept: string | null }> = []
  await expect(loadBootstrap(async (input, init) => {
    calls.push({ path: String(input), accept: new Headers(init?.headers).get("accept") })
    return new Response("PRIVATE_BODY", { status })
  })).rejects.toMatchObject({ _tag: "BootstrapFailure", kind, status, message })
  expect(calls).toEqual([{ path: "/api/bootstrap", accept: "application/json" }])
})

for (const body of ["not-json", "null", "[]", '{"apiVersion":2}']) test(`bootstrap body ${body} cannot become a runtime`, async () => {
  const error = await loadBootstrap(async () => new Response(body)).catch((caught: unknown) => caught)
  expect(error).toMatchObject({ _tag: "BootstrapFailure", kind: "invalid", message: "Backend returned an invalid Smithers bootstrap." })
  expect(error).not.toHaveProperty("status")
})
