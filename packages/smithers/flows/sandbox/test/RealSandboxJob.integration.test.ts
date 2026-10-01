import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as Microsandbox from "microsandbox"
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import { makeWorkSeed } from "./helpers/workSeed.ts"

const guard = process.env.SMITHERS_REAL_SANDBOX_JOB === "1"
const cached = spawnSync("microsandbox", ["image", "list"], { encoding: "utf8", timeout: 10000 })
const missingHypervisor = (() => {
  if (process.platform === "darwin") {
    const probe = (name: string) =>
      spawnSync("sysctl", ["-n", name], { encoding: "utf8", timeout: 10000 }).stdout?.trim()
    return probe("kern.hv_support") !== "1" || probe("kern.hv_vmm_present") === "1"
  }
  if (process.platform !== "linux") return true
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK)
    return false
  } catch {
    return true
  }
})()
const available = guard && !missingHypervisor && cached.status === 0 && cached.stdout.includes("node:26-trixie")
describe.skipIf(!available)("retained Sandbox.job real microVM", () => {
  it("survives host SIGKILL, reacquires without losing job metadata, captures once, and destroys", async () => {
    const owner = `job-real-${process.pid}-${Date.now()}`
    const key = `${owner}#g1`
    const store = mkdtempSync(join(tmpdir(), "job-real-receipts-"))
    const provider = MicrosandboxSandbox.make({
      sdk: Microsandbox,
      image: "node:26-trixie",
      pullPolicy: "never",
      persistence: "sticky",
      network: "none",
      owner,
      maxDurationSecs: 300,
      idleTimeoutSecs: 240
    })
    const child = spawn(process.execPath, [
      new URL("./fixtures/retained-job-child.mjs", import.meta.url).pathname,
      JSON.stringify({ owner, key, bundle: Buffer.from(makeWorkSeed().bundle).toString("base64") })
    ], { stdio: ["ignore", "pipe", "pipe"] })
    let handle: Sandbox.JobHandle | undefined
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    const run = <A, E>(effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore>) =>
      Effect.runPromise(
        effect.pipe(Effect.provide(KeyValueStore.layerFileSystem(store)), Effect.provide(NodeServices.layer))
      )
    try {
      handle = await new Promise<Sandbox.JobHandle>((resolve, reject) => {
        let out = ""
        const timer = setTimeout(() => reject(new Error(`job child timed out: ${stderr}`)), 120000)
        child.stdout.on("data", (chunk) => {
          out += chunk
          const line = out.split("\n").find((line) => line.startsWith("{\"id\":"))
          if (line) {
            clearTimeout(timer)
            resolve(Sandbox.JobHandle.make(JSON.parse(line)))
          }
        })
        child.on("exit", (code) => {
          clearTimeout(timer)
          reject(new Error(`job child exited ${code}: ${stderr}`))
        })
      })
      child.kill("SIGKILL")
      await new Promise<void>((resolve) => child.once("exit", () => resolve()))
      const adapter = Sandbox.job(provider, {
        command: "unused on replay",
        capture: { checkout: "/workspace/checkout" }
      })
      // Ordinary re-acquire clears transient exec pids but retains job metadata.
      await run(Effect.scoped(provider.acquire(key)))
      let status = await run(adapter.status(handle, key))
      for (let i = 0; i < 100 && status._tag !== "Exited"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        status = await run(adapter.status(handle, key))
      }
      expect(status).toEqual({ _tag: "Exited", exitCode: 0 })
      if (status._tag !== "Exited") throw new Error("job did not exit")
      const result = await run(adapter.collect(handle, key, status))
      expect(result.work._tag).toBe("Changed")
      expect(result.work._tag === "Changed" && result.work.patch).toContain("recovered")
      expect(await run(adapter.collect(handle, key, status))).toEqual(result)
      expect(await run(adapter.status(handle, key))).toEqual({ _tag: "Lost" })
    } finally {
      child.kill("SIGKILL")
      if (handle) await run(provider.destroy!(handle))
      await run(MicrosandboxSandbox.reap({ sdk: Microsandbox, owner, isAlive: () => Effect.succeed(false) }))
      rmSync(store, { recursive: true, force: true })
    }
  }, 180000)
})
describe.skipIf(available)("retained Sandbox.job capability guard", () => {
  it(`skips because ${!guard ? "SMITHERS_REAL_SANDBOX_JOB=1 was not supplied" : missingHypervisor ? "this host lacks a usable hypervisor" : "cached node:26-trixie or runnable Microsandbox is absent"}`, () =>
    expect(available).toBe(false))
})
