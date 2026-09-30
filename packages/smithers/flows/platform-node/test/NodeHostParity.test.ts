import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import { HostServiceIds } from "@smthrs/kernel/HostServices"
import * as KernelProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Layer, Path, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as NativeFs from "node:fs"
import * as NativeOs from "node:os"
import * as NativePath from "node:path"
import * as NodeHost from "../src/NodeHost.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

it("identifies every host implementation", () => {
  expect(Object.keys(NodeHost.implementationIds).sort()).toEqual([...HostServiceIds].sort())
  // Every bundle installs the proxy-aware egress client, not the raw Undici pool.
  expect(NodeHost.implementationIds["effect/HttpClient"]).toBe("@smthrs/platform-node/EgressHttpClient")
})
it.effect("uses native path semantics for absolute filesystem paths", () =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const root = process.cwd()
    expect(path.sep).toBe(NativePath.sep)
    expect(path.isAbsolute(root)).toBe(true)
    expect(path.resolve(root, "..", "next")).toBe(NativePath.resolve(root, "..", "next"))
    expect(path.join(root, "nested", "file.ts")).toBe(NativePath.join(root, "nested", "file.ts"))
  }).pipe(Effect.provide(NodeHost.layerAt(process.cwd()))))

it("refuses invalid roots with the NodeHost error before composition", () => {
  for (const factory of [NodeHost.layerAt, NodeHost.layerContainedAt]) {
    for (const root of ["", "relative", "x".repeat(1000)]) {
      expect(() => factory(root)).toThrow(NodeHost.NodeHostError)
      try {
        factory(root)
      } catch (error) {
        expect(error).toMatchObject({
          _tag: "@smthrs/platform-node/NodeHostError",
          name: "NodeHostError",
          code: "invalid_repository_root"
        })
        expect((error as Error).message.length).toBeLessThan(200)
      }
    }
    expect(factory("/repo")).toBeDefined()
  }
})

it.effect("every native host bundle provides real process confinement", () =>
  Effect.gen(function*() {
    for (
      const host of [
        NodeHost.layer,
        NodeHost.layerAt(process.cwd()),
        NodeHost.layerContained(),
        NodeHost.layerContainedAt(process.cwd())
      ]
    ) {
      const seam = yield* KernelProcessConfinement.ProcessConfinement.pipe(
        Effect.provide(host),
        Effect.provide(ProcessLedger.layerMemory({ hostId: "node-host-parity", ownerPid: process.pid }))
      )
      expect(seam.confine).toBeTypeOf("function")
      expect(seam).not.toBe(KernelProcessConfinement.makeNoop)
    }
  }))

describe.skipIf(ProcessSandbox.isUnenforceable(ProcessSandbox.select({ network: "none" }, ProcessSandbox.host())))(
  "native host confinement",
  () => {
    it.effect("guarded native host confines an approved shell without separate seam wiring", () =>
      Effect.scoped(Effect.gen(function*() {
        const scratch = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NativeFs.realpathSync(
              NativeFs.mkdtempSync(
                NativePath.join(process.env.SMITHERS_TEST_SCRATCH ?? NativeOs.tmpdir(), "nodehost-confinement-")
              )
            )
          ),
          (root) => Effect.sync(() => NativeFs.rmSync(root, { recursive: true, force: true }))
        )
        const result = yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(
            ChildProcess.make("/bin/sh", ["-c", "printf started; printf forbidden > output.txt"])
          )
          const [exitCode, stdout] = yield* Effect.all([
            handle.exitCode,
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString)
          ], { concurrency: "unbounded" })
          return { exitCode, stdout }
        }).pipe(
          Effect.provide(HostServices.layer),
          Effect.provide(
            Layer.orDie(
              GrantStore.layer({
                attended: false,
                rules: [
                  new Rule({
                    effect: "allow",
                    pattern: new CapabilityPattern({ action: "proc:spawn", resource: "**" })
                  })
                ]
              })
            )
          ),
          Effect.provide(NodeHost.layerAt(scratch)),
          Effect.provide(Workspace.layer(scratch))
        )
        expect(result.stdout).toBe("started")
        expect(Number(result.exitCode)).not.toBe(0)
        expect(NativeFs.existsSync(NativePath.join(scratch, "output.txt"))).toBe(false)
      })))
  }
)
