import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Memory from "@smthrs/agent/Memory"
import * as MemoryCalibration from "@smthrs/agent/MemoryCalibration"
import * as Capability from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as Source from "@smthrs/memory/Source"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, FileSystem, Layer, Option } from "effect"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as SupervisorMemory from "../src/internal/SupervisorMemory.ts"

const roots: Array<string> = []
const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "supervisor-memory-ceiling-")))
  roots.push(root)
  mkdirSync(join(root, ".smithers"))
  writeFileSync(join(root, MemoryCalibration.file), "{\"version\":1}")
  writeFileSync(join(root, "secret.ts"), "export const secret = 'private workspace bytes'\n")
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const patterns = (values: ReadonlyArray<string>) =>
  values.map((value) => Option.getOrThrow(Capability.parsePattern(value)))
const digest = (binding: FlowBinding.Binding) =>
  binding.descriptor.body._tag === "Module"
    ? binding.descriptor.body.contentDigest
    : undefined

/** The same isolated-volume Node adapter used by the kernel integration suite. */
const isolated = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, KernelFileSystem.withIsolatedFileSystem)
)

const guarded = <A, E, R>(root: string, use: Effect.Effect<A, E, R>) =>
  use.pipe(
    Effect.provide(KernelFileSystem.layer.pipe(Layer.provide(isolated))),
    Effect.provide(Layer.orDie(GrantStore.layer({
      attended: false,
      // Broad host grants must still obey the run's narrower ceiling.
      rules: [new Rule({ effect: "allow", pattern: patterns(["fs:read:**"])[0]! })]
    }))),
    Effect.provide(Workspace.layer(root)),
    Effect.provide(Evaluator.layerScripted((request) =>
      Object.fromEntries(Object.keys(request.questions).map((id) => [id, { probability: 0.01 }]))
    )),
    Effect.provide(NodeServices.layer),
    Effect.scoped
  )

describe("supervisor memory capability ceiling", () => {
  it.each([
    { label: "process-only", capabilities: ["proc:spawn:**"], sealed: false, ceiling: ["proc:spawn:**"] },
    {
      label: "exact bank only",
      capabilities: ["memory:read:global-team", "memory:write:user-will"],
      sealed: false,
      ceiling: ["memory:read:global-team", "memory:write:user-will"]
    },
    {
      label: "sealed host",
      capabilities: ["fs:read:**", "memory:read:global-team"],
      sealed: true,
      ceiling: ["fs:read:**", "memory:read:global-team"]
    },
    {
      label: "broad ambient grants narrowed by the launch",
      capabilities: ["memory:read:global-team"],
      sealed: false,
      ceiling: ["fs:read:**", "memory:read:*"]
    },
    {
      label: "broad launch narrowed by the ambient ceiling",
      capabilities: ["fs:read:**", "memory:read:global-team"],
      sealed: false,
      ceiling: ["memory:read:global-team"]
    },
    { label: "wildcard bank", capabilities: ["memory:read:*"], sealed: false, ceiling: ["memory:read:*"] }
  ])("opens $label without reading repository thresholds or seeds", async ({ capabilities, sealed, ceiling }) => {
    const root = scratch()
    const recalled: Array<Recall.Input> = []
    const attempted: Array<string> = []
    const program = Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const opening = yield* SupervisorMemory.opening({
        runId: "ceiling",
        prompt: "fix secret.ts",
        history: ["previous release question"],
        capabilities
      }, { root, sealed }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (path, encoding) => {
            attempted.push(path)
            return fs.readFileString(path, encoding)
          }
        }),
        Effect.provideService(MemoryStore.MemoryStore, MemoryStore.makeNoop()),
        Effect.provideService(Recall.Recall, {
          recall: (input) => {
            recalled.push(input)
            return Effect.succeed(input.banks.map((bank) => ({ bank, key: "release", score: 1, text: "a fact" })))
          }
        })
      )
      expect(attempted).toEqual([])
      const hasBank = capabilities.includes("memory:read:global-team")
      expect(opening.rows.map((row) => row.key)).toEqual(hasBank ? ["fact/global-team/release"] : [])
      expect(recalled.map((input) => input.banks)).toEqual(hasBank ? [["global-team"]] : [])
      if (hasBank) expect(recalled[0]?.query).toContain("previous release question")
      expect(Source.render(opening.rows)).not.toContain("private workspace bytes")
    }).pipe(CapabilitySet.attenuate(patterns(ceiling)))
    await Effect.runPromise(guarded(root, program))
  })

  it.each([{ ceiling: ["proc:spawn:**"] }, { ceiling: ["memory:read:global-team"] }, {
    ceiling: ["fs:read:/other/**"]
  }])(
    "assembles the public memory source under %j with the initial calibration",
    async ({ ceiling }) => {
      const root = scratch()
      const program = Effect.gen(function*() {
        const services = yield* Effect.context<Memory.Requirements | Evaluator.Evaluator>()
        const catalog = yield* FlowBinding.catalog([Memory.source(services, { root })]).pipe(
          CapabilitySet.attenuate(patterns(ceiling))
        )
        expect(catalog.entries).toHaveLength(1)
        expect(digest(catalog.entries[0]!)).toBe(
          digest(Memory.binding(services, { root, thresholds: MemoryCalibration.initial }))
        )
        expect(catalog.entries[0]!.descriptor.capabilities).toContain(Capability.format(Memory.reads))
      }).pipe(CapabilitySet.attenuate(patterns(["fs:read:**", "memory:read:*", "proc:spawn:**"])))
      await Effect.runPromise(guarded(root, program))
    }
  )

  it.each(["malformed", "unreadable"])("refuses authorized %s repository thresholds", async (kind) => {
    const root = scratch()
    if (kind === "unreadable") {
      rmSync(join(root, MemoryCalibration.file))
      mkdirSync(join(root, MemoryCalibration.file))
    }
    const failure = await Effect.runPromise(guarded(
      root,
      Effect.gen(function*() {
        const services = yield* Effect.context<Memory.Requirements | Evaluator.Evaluator>()
        return yield* Effect.flip(FlowBinding.catalog([Memory.source(services, { root })]))
      }).pipe(CapabilitySet.attenuate(patterns(["fs:read:**"])))
    ))
    expect(failure).toMatchObject({
      code: "assembly_failed",
      message: expect.stringMatching(kind === "malformed" ? /^thresholds_invalid: / : /^read_failed: /)
    })
  })

  it("refuses malformed thresholds in an authorized workspace opening as sealable JSON", async () => {
    const root = scratch()
    const failure = await Effect.runPromise(guarded(
      root,
      Effect.flip(SupervisorMemory.opening({
        runId: "authorized",
        prompt: "fix secret.ts",
        history: [],
        capabilities: ["fs:read:**"]
      }, { root, sealed: false })).pipe(
        Effect.provideService(MemoryStore.MemoryStore, MemoryStore.makeNoop()),
        Effect.provideService(Recall.Recall, { recall: () => Effect.succeed([]) }),
        CapabilitySet.attenuate(patterns(["fs:read:**"]))
      )
    ))
    expect(failure).toMatchObject({ code: "thresholds_invalid" })
    expect(failure).not.toBeInstanceOf(Error)
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure)
  })

  it("pins explicit thresholds under denied reads and still refuses the bound call's file read", async () => {
    const root = scratch()
    const explicit: MemoryCalibration.Thresholds = {
      ...MemoryCalibration.initial,
      decisions: {
        ...MemoryCalibration.initial.decisions,
        file: { ...MemoryCalibration.initial.decisions.file, tau: 0.123 }
      }
    }
    await Effect.runPromise(guarded(
      root,
      Effect.gen(function*() {
        const services = yield* Effect.context<Memory.Requirements | Evaluator.Evaluator>()
        const catalog = yield* FlowBinding.catalog([Memory.source(services, {
          root,
          thresholds: explicit
        })])
        const binding = catalog.entries[0]!
        expect(digest(binding)).toBe(digest(Memory.binding(services, { root, thresholds: explicit })))
        expect(digest(binding)).not.toBe(digest(Memory.binding(services, { root })))
        const result = yield* binding.run(
          new Cell.Call({
            flowName: Memory.name,
            input: { task: "fix secret.ts", sources: ["repo"] },
            capabilities: binding.descriptor.capabilities,
            effects: binding.descriptor.effects,
            placement: binding.descriptor.placement,
            identity: new Cell.CallIdentity({
              session: "ceiling",
              frame: 0,
              cell: "cell-digest",
              ordinal: 0,
              declaration: Cell.declarationDigest(binding.descriptor),
              layers: []
            })
          })
        )
        expect(result.outcome).toBe("failure")
        expect(result.message).toContain("PermissionDenied")
        expect(JSON.stringify(result)).not.toContain("private workspace bytes")
        const fs = yield* FileSystem.FileSystem
        const denied = yield* Effect.flip(fs.readFileString(join(root, "secret.ts")))
        expect(denied.reason._tag).toBe("PermissionDenied")
      }).pipe(CapabilitySet.attenuate(patterns(["memory:read:global-team"])))
    ))
  })
})
