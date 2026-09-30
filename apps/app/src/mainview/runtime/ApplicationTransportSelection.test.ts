import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// The runtime deliberately caches its client for the page lifetime. Give it a
// real process lifetime rather than retaining a mock-bound singleton in the suite.
test("a cached client cannot borrow another backend's token while same-backend rotation remains live", () => {
  const child = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict"
    import { GlobalRegistrator } from "@happy-dom/global-registrator"
    import { loadRuntimeApplicationClient } from "./src/mainview/runtime/ApplicationTransport"
    import { switchBackendTarget } from "./src/mainview/runtime/BackendTargetSelection"
    GlobalRegistrator.register({ url: "https://shell.test" })
    const calls = []
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
      return Response.json({ ok: true })
    }
    try {
      switchBackendTarget("https://first.test", "first-inert-token", location.origin)
      const loading = loadRuntimeApplicationClient()
      sessionStorage.removeItem("smithers.backend-target")
      sessionStorage.removeItem("smithers.backend-token")
      sessionStorage.setItem("smithers.developer-api-token", "unrelated-deployment-token")
      const client = await loading
      await assert.rejects(client.request("/api/probe"), { code: "auth-missing" })
      assert.equal(calls.length, 0)
      switchBackendTarget("https://first.test", "first-inert-token", location.origin)
      await client.request("/api/probe")
      switchBackendTarget("https://first.test", "rotated-inert-token", location.origin)
      await client.request("/api/probe")
      assert.deepEqual(calls, [
        { url: "https://first.test/api/probe", authorization: "Bearer first-inert-token" },
        { url: "https://first.test/api/probe", authorization: "Bearer rotated-inert-token" }
      ])
      switchBackendTarget("https://second.test", "second-inert-token", location.origin)
      await assert.rejects(client.request("/api/probe"), { code: "auth-missing" })
      assert.equal(calls.length, 2)
      console.log("target-bound credential assertions passed")
    } finally {
      globalThis.fetch = original
      sessionStorage.clear()
      await GlobalRegistrator.unregister()
    }
  `], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", timeout: 5000 })
  expect({ status: child.status, signal: child.signal, error: child.error, stderr: child.stderr })
    .toEqual({ status: 0, signal: null, error: undefined, stderr: "" })
  expect(child.stdout.trim()).toBe("target-bound credential assertions passed")
})
