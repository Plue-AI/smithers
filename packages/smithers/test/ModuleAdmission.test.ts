/**
 * The admission guard, seen from the outside.
 *
 * A persisted native root may be adopted only while it still matches the plan
 * a person approved. For a module flow that identity is
 * `Descriptor.executionDigest`, and the reason this suite exists is that the
 * digest has to cover more than the entry file: a self-contained flow's body
 * runs the modules its entry imports from beside itself, and those are code an
 * approval has to be about.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Descriptor from "@smthrs/registry/Descriptor"
import type * as Executable from "@smthrs/registry/Executable"
import { Effect, Option } from "effect"
import * as ModuleAdmission from "../src/internal/ModuleAdmission.ts"

const flowId = "agents/build"
const runId = "run-1"
const planId = "plan-1"

/**
 * One self-contained module flow, pinned to a sibling it imports.
 *
 * `helper` is the digest of `helper.ts`. Nothing else about the descriptor
 * changes between the two values, so any identity difference is the sibling's.
 */
const descriptorWith = (helper: string): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name: flowId,
    description: "Builds the project.",
    body: new Descriptor.BodyRefModule({
      path: "/flows/agents/build/flow.ts",
      contentDigest: "a".repeat(64),
      imports: [{ path: "helper.ts", contentDigest: helper }]
    }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    modelInvocable: false,
    path: "/flows/agents/build",
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

const approved = descriptorWith("c".repeat(64))
/** The same flow after the module its entry imports was edited. */
const edited = descriptorWith("d".repeat(64))

/** A self-contained flow delegates to nothing, so the envelope names nothing. */
const executableFor = (descriptor: Descriptor.FlowDescriptor): Executable.Executable =>
  ({ descriptor, delegate: undefined }) as unknown as Executable.Executable

const admit = (options: {
  readonly registered: Descriptor.FlowDescriptor
  readonly catalogued?: Descriptor.FlowDescriptor | undefined
  readonly approvedDigest?: string | undefined
}) =>
  ModuleAdmission.make({
    runs: {
      get: () =>
        Effect.succeed({
          cancelRequestedAtMs: null,
          stateJson: JSON.stringify({ version: 1, flowName: "agent/run", payload: { planId } })
        })
    } as never,
    control: {
      getRun: () => Effect.succeed({ planId, planDigest: "plan-digest" }),
      getPlan: () =>
        Effect.succeed({
          decision: "approved",
          card: {
            planId,
            flowId,
            digest: "plan-digest",
            executionDigest: options.approvedDigest ?? Descriptor.executionDigest(options.registered),
            envelope: { capabilities: [], flows: [], budget: {} }
          }
        })
    } as never,
    registry: {
      get: () => Effect.succeed(options.registered),
      loadBody: () => Effect.succeed(new Descriptor.FlowBodyModule({ path: "/flows/agents/build/flow.ts" }))
    } as never,
    catalog: options.catalogued === undefined
      ? undefined
      : { executables: [executableFor(options.catalogued)], refused: [] }
  })(runId)

describe("adopting a persisted module root", () => {
  it.effect("admits the flow the approved plan was about", () =>
    Effect.gen(function*() {
      expect(yield* admit({ registered: approved, catalogued: approved })).toBe(true)
    }))

  it.effect("refuses it once a module its entry imports has changed", () =>
    Effect.gen(function*() {
      // The entry file is byte-identical: only `helper.ts` moved. Before the
      // closure entered the identity this admitted, and the edited sibling ran
      // under an approval granted for the old one.
      expect(edited.body.contentDigest).toBe(approved.body.contentDigest)
      expect(Descriptor.executionDigest(edited)).not.toBe(Descriptor.executionDigest(approved))

      expect(
        yield* admit({
          registered: approved,
          catalogued: edited,
          approvedDigest: Descriptor.executionDigest(approved)
        })
      ).toBe(false)
    }))

  it.effect("keeps refusing a delegating flow whose delegate the envelope never named", () =>
    Effect.gen(function*() {
      // The other half of the same check: a delegate is host-registered code
      // the descriptor never measured, so the envelope has to name it. Relaxing
      // it for a self-contained flow must not relax it here.
      const delegating = ModuleAdmission.make({
        runs: {
          get: () =>
            Effect.succeed({
              cancelRequestedAtMs: null,
              stateJson: JSON.stringify({ version: 1, flowName: "agent/run", payload: { planId } })
            })
        } as never,
        control: {
          getRun: () => Effect.succeed({ planId, planDigest: "plan-digest" }),
          getPlan: () =>
            Effect.succeed({
              decision: "approved",
              card: {
                planId,
                flowId,
                digest: "plan-digest",
                executionDigest: Descriptor.executionDigest(approved),
                envelope: { capabilities: [], flows: [], budget: {} }
              }
            })
        } as never,
        registry: {
          get: () => Effect.succeed(approved),
          loadBody: () => Effect.succeed(new Descriptor.FlowBodyModule({ path: "/flows/agents/build/flow.ts" }))
        } as never,
        catalog: {
          executables: [
            ({ descriptor: approved, delegate: "coding/CommandCheck" }) as unknown as Executable.Executable
          ],
          refused: []
        }
      })(runId)

      expect(yield* delegating).toBe(false)
    }))
})

describe("cancellation-only admission", () => {
  for (const cancelRequestedAtMs of [0, 1790918173888]) {
    it.effect(`admits durable cancellation at ${cancelRequestedAtMs} without approval or loading code`, () =>
      Effect.gen(function*() {
        const forbidden = () => Effect.die("Cancellation attempted to look up executable code")
        const cleanup = ModuleAdmission.make({
          runs: { get: () => Effect.succeed({ cancelRequestedAtMs, stateJson: "unavailable legacy state" }) } as never,
          control: { getRun: forbidden, getPlan: forbidden } as never,
          registry: { get: forbidden, loadBody: forbidden } as never,
          catalog: undefined
        })
        expect(yield* cleanup(runId)).toBe(true)
      }))
  }

  it.effect("refuses normal execution when the approved module is missing from the host catalog", () =>
    Effect.gen(function*() {
      expect(yield* admit({ registered: approved })).toBe(false)
    }))

  it.effect("does not treat absent legacy cancellation metadata as consent", () =>
    Effect.gen(function*() {
      const unrequested = ModuleAdmission.make({
        runs: { get: () => Effect.succeed({ stateJson: "unavailable legacy state" }) } as never,
        control: {} as never,
        registry: {} as never,
        catalog: undefined
      })
      expect(yield* unrequested(runId)).toBe(false)
    }))
})
