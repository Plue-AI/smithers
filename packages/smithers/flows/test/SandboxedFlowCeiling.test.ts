/**
 * Capability ceilings across the sandboxed runner protocol.
 *
 * Two processes, no fakes at the boundary: the host bundles the guarded
 * fixture, a real `node` guest runs it in a `DirectorySandbox` workspace, and
 * the guest's writes go through the kernel's guarded `FileSystem` over a real
 * `GrantStore` whose rules allow everything, so the ceiling the host sent is
 * the only thing that can refuse one. Tampered and replayed results are
 * produced by wrapper runtimes around the same real guest.
 */
import { NodeCrypto } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { PermissionDenied } from "@smthrs/capability/Permission"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { DirectorySandbox, type Sandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Action, Engine, Flow, Interpreter } from "../src/index.ts"
import * as SandboxedFlow from "../src/SandboxedFlow.ts"
import { Guarded, ReadOnly, touch } from "./fixtures/sandboxed-guarded.ts"
import * as guarded from "./fixtures/sandboxed-guarded.ts"

const root = mkdtempSync(join(tmpdir(), "flows-sandboxed-ceiling-"))
const scratch = mkdtempSync(join(tmpdir(), "flows-sandboxed-ceiling-scratch-"))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
})

const entry = new URL("./fixtures/sandboxed-guarded.ts", import.meta.url)

const platform = NodeHost.layerContained({ graceMs: 80 }).pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "sandboxed-ceiling-tests", ownerPid: process.pid }))
)

const provider = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return DirectorySandbox.make({ fs, spawner, root })
}).pipe(Effect.provide(platform))

/** A provider that records every session key and every request the host writes. */
const recording = (
  base: Sandbox.Provider,
  seen: { readonly keys: Array<string>; readonly requests: Array<unknown> }
): Sandbox.Provider => ({
  acquire: (key) =>
    Effect.map(base.acquire(key), (session): Sandbox.Session => {
      seen.keys.push(key)
      return {
        ...session,
        writeFile: (path, bytes) => {
          if (path.endsWith("/request.json")) seen.requests.push(JSON.parse(new TextDecoder().decode(bytes)))
          return session.writeFile(path, bytes)
        }
      }
    })
})

/** A guest runtime: a shell script started as `<script> <bundle>`. */
const runtime = (name: string, body: string): string => {
  const path = join(scratch, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return path
}

const node = JSON.stringify(process.execPath)
const writeAnywhere = new CapabilityPattern({ action: "fs:write", resource: "**" })
const readAnywhere = new CapabilityPattern({ action: "fs:read", resource: "**" })

const wire = (groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>> | null) =>
  groups?.map((group) => group.map(({ action, resource }) => ({ action, resource })))

let sessions = 0
const run = <Tag extends string, Requires>(
  flow: Flow.Flow<Tag, typeof Guarded.payloadSchema, typeof Schema.String, typeof PermissionDenied, Requires>,
  name: string,
  options: Partial<SandboxedFlow.ExecuteOptions> = {}
) =>
  Effect.gen(function*() {
    const directory = yield* provider
    return yield* SandboxedFlow.execute(flow, { name }, {
      provider: directory,
      session: `ceiling-${process.pid}-${sessions++}`,
      entry,
      ...options
    })
  })

/** The same flow run in this process under the same guarded host. */
const runLocally = (
  name: string,
  ceiling: ReadonlyArray<CapabilityPattern>
): Effect.Effect<boolean, unknown> => {
  const workspace = mkdtempSync(join(scratch, "local-"))
  return Guarded.execute({ name }, { executionId: `local-${name}` }).pipe(
    CapabilitySet.attenuate(ceiling),
    Effect.provide(
      Layer.mergeAll(touch, Interpreter.layer(Guarded)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Engine.FlowEngine.layerMemory),
        Layer.provideMerge(guarded.host(workspace)),
        Layer.provideMerge(NodeCrypto.layer)
      )
    ),
    Effect.map(() => existsSync(join(workspace, name)))
  )
}

describe("SandboxedFlow carries the caller's capability ceiling to the guest", () => {
  it.live(
    "runs a covered write under the ceiling it sent and returns that ceiling as the receipt",
    () =>
      Effect.gen(function*() {
        const seen = { keys: [] as Array<string>, requests: [] as Array<unknown> }
        const result = yield* run(Guarded, "allowed.txt", {
          provider: recording(yield* provider, seen),
          collectDiff: true
        }).pipe(CapabilitySet.attenuate([writeAnywhere]))
        expect(result.output).toBe("allowed.txt")
        expect(result.diff.map((file) => file.path)).toEqual(["allowed.txt"])
        expect(wire(result.capabilityCeiling)).toEqual([[{ action: "fs:write", resource: "**" }]])
        expect(seen.requests).toEqual([
          expect.objectContaining({ capabilityCeiling: [[{ action: "fs:write", resource: "**" }]] })
        ])
      }),
    60_000
  )

  it.live("sends no groups for an unrestricted caller and a flow that declares none", () =>
    Effect.gen(function*() {
      const result = yield* run(Guarded, "open.txt", { collectDiff: true })
      expect(result.output).toBe("open.txt")
      expect(result.diff.map((file) => file.path)).toEqual(["open.txt"])
      expect(result.capabilityCeiling).toEqual([])
    }), 60_000)

  it.live(
    "refuses a write outside the ceiling with the PermissionDenied a local run fails with",
    () =>
      Effect.gen(function*() {
        const remote = yield* Effect.flip(
          run(Guarded, "denied.txt", { collectDiff: true }).pipe(CapabilitySet.attenuate([readAnywhere]))
        )
        const local = yield* Effect.flip(runLocally("denied.txt", [readAnywhere]))
        expect(remote).toBeInstanceOf(PermissionDenied)
        expect(local).toBeInstanceOf(PermissionDenied)
        const shape = (denied: unknown) => {
          const { capability, code, reason } = denied as PermissionDenied
          return { code, reason, action: capability.action, file: capability.resource.split("/").at(-1) }
        }
        expect(shape(remote)).toEqual({
          code: "permission_denied",
          reason: "outside capability ceiling",
          action: "fs:write",
          file: "denied.txt"
        })
        expect(shape(remote)).toEqual(shape(local))
      }),
    60_000
  )

  it.live("refuses every guarded operation under an empty ceiling", () =>
    Effect.gen(function*() {
      const denied = yield* Effect.flip(run(Guarded, "nothing.txt").pipe(CapabilitySet.attenuate([])))
      expect(denied).toBeInstanceOf(PermissionDenied)
      expect((denied as PermissionDenied).reason).toBe("outside capability ceiling")
    }), 60_000)

  it.live(
    "never widens: a wildcard caller still gets the flow's own read-only declaration",
    () =>
      Effect.gen(function*() {
        const seen = { keys: [] as Array<string>, requests: [] as Array<unknown> }
        const denied = yield* Effect.flip(
          run(ReadOnly, "declared.txt", { provider: recording(yield* provider, seen) }).pipe(
            CapabilitySet.attenuate([new CapabilityPattern({ action: "*", resource: "**" })])
          )
        )
        expect(denied).toBeInstanceOf(PermissionDenied)
        expect(seen.requests).toEqual([
          expect.objectContaining({
            capabilityCeiling: [[{ action: "*", resource: "**" }], [{ action: "fs:read", resource: "**" }]]
          })
        ])
      }),
    60_000
  )
})

describe("SandboxedFlow verifies the ceiling a result was produced under", () => {
  const failure = <E>(effect: Effect.Effect<unknown, E>) =>
    Effect.flip(effect).pipe(
      Effect.map((error) => {
        expect(error).toBeInstanceOf(SandboxedFlow.SandboxedFlowError)
        return error as SandboxedFlow.SandboxedFlowError
      })
    )

  it.live("refuses a result whose runner claims a wider ceiling than the host sent", () =>
    Effect.gen(function*() {
      const widened = runtime(
        "widen",
        `${node} "$1" || exit $?\n${node} -e '` +
          `const fs = require("fs"); const path = process.env.SMITHERS_SANDBOX_RESULT_PATH;` +
          `const result = JSON.parse(fs.readFileSync(path, "utf8"));` +
          `fs.writeFileSync(path, JSON.stringify({ attempt: result.attempt, capabilityCeiling: [],` +
          ` status: "succeeded", output: "widened" }))'`
      )
      const refused = yield* failure(
        run(Guarded, "widened.txt", { runtime: widened }).pipe(CapabilitySet.attenuate([readAnywhere]))
      )
      expect(refused.code).toBe("result_unreadable")
      expect(refused.message).toContain("capability ceiling other than the one the host sent")
    }), 60_000)

  it.live("refuses a result from a runner that does not echo the ceiling", () =>
    Effect.gen(function*() {
      const silent = runtime(
        "silent",
        `${node} -e '` +
          `const fs = require("fs");` +
          `const request = JSON.parse(fs.readFileSync(process.env.SMITHERS_SANDBOX_REQUEST_PATH, "utf8"));` +
          `fs.writeFileSync(process.env.SMITHERS_SANDBOX_RESULT_PATH,` +
          ` JSON.stringify({ attempt: request.attempt, status: "succeeded", output: "unbounded" }))'`
      )
      const refused = yield* failure(
        run(Guarded, "silent.txt", { runtime: silent }).pipe(CapabilitySet.attenuate([readAnywhere]))
      )
      expect(refused.code).toBe("result_unreadable")
      expect(refused.message).toContain("not the protocol's JSON")
    }), 60_000)

  it.live("refuses a replayed result an earlier attempt produced under a wider ceiling", () =>
    Effect.gen(function*() {
      const stash = join(scratch, "replayed-result.json")
      const capture = runtime("capture", `${node} "$1" || exit $?\ncp "$SMITHERS_SANDBOX_RESULT_PATH" '${stash}'`)
      const earlier = yield* run(Guarded, "replayed.txt", { runtime: capture }).pipe(
        CapabilitySet.attenuate([writeAnywhere])
      )
      expect(earlier.output).toBe("replayed.txt")
      expect(existsSync(stash)).toBe(true)
      const replay = runtime("replay", `cp '${stash}' "$SMITHERS_SANDBOX_RESULT_PATH"`)
      const refused = yield* failure(
        run(Guarded, "replayed.txt", { runtime: replay }).pipe(CapabilitySet.attenuate([writeAnywhere]))
      )
      expect(refused.code).toBe("result_unreadable")
      expect(refused.message).toContain("different attempt")
    }), 60_000)
})

describe("a sandboxed action journals the ceiling receipt and the refusal in the parent", () => {
  const RunGuarded = SandboxedFlow.action(Guarded)
  const parent = (capabilities: ReadonlyArray<string>) =>
    Flow.make(`flows/SandboxedFlow/ceiling/Parent/${capabilities.join(",")}`, {
      payload: { name: Schema.String },
      success: RunGuarded.successSchema,
      error: SandboxedFlow.ExecuteError,
      capabilities,
      body: (payload) => RunGuarded.call(payload)
    })

  const execute = (capabilities: ReadonlyArray<string>, name: string) =>
    Effect.gen(function*() {
      const Parent = parent(capabilities)
      const seen = { keys: [] as Array<string>, requests: [] as Array<unknown> }
      const implementation = SandboxedFlow.toLayer(RunGuarded, Guarded, ({ callId, executionId }) => ({
        provider: recording(directory, seen),
        session: `parent-${process.pid}-${executionId}-${callId}`,
        entry
      }))
      const directory = yield* provider
      const layers = Layer.mergeAll(implementation, Interpreter.layer(Parent)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Engine.FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
      const executionId = `parent-${name}`
      return yield* Effect.gen(function*() {
        const first = yield* Effect.exit(Parent.execute({ name }, { executionId }))
        const second = yield* Effect.exit(Parent.execute({ name }, { executionId }))
        return { first, second, seen }
      }).pipe(Effect.provide(layers))
    })

  it.live(
    "records the enforced ceiling with the result and replays it without a machine",
    () =>
      Effect.gen(function*() {
        const { first, second, seen } = yield* execute(["fs:write:**"], "journaled.txt")
        expect(first._tag).toBe("Success")
        const result = first._tag === "Success" ? first.value : undefined
        expect(result?.output).toBe("journaled.txt")
        expect(wire(result!.capabilityCeiling)).toEqual([[{ action: "fs:write", resource: "**" }]])
        expect(second).toEqual(first)
        expect(seen.keys).toHaveLength(1)
      }),
    60_000
  )

  it.live("fails the parent with the guest's PermissionDenied and replays that refusal", () =>
    Effect.gen(function*() {
      const { first, second, seen } = yield* execute(["fs:read:**"], "refused.txt")
      expect(first._tag).toBe("Failure")
      const error = first._tag === "Failure" ? first.cause.reasons[0] : undefined
      expect(error?._tag).toBe("Fail")
      const denied = error?._tag === "Fail" ? error.error : undefined
      expect(denied).toBeInstanceOf(PermissionDenied)
      expect((denied as PermissionDenied).reason).toBe("outside capability ceiling")
      expect(seen.requests).toEqual([
        expect.objectContaining({ capabilityCeiling: [[{ action: "fs:read", resource: "**" }]] })
      ])
      expect(second).toEqual(first)
      expect(seen.keys).toHaveLength(1)
    }), 60_000)
})
