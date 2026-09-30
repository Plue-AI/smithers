/**
 * The migration modules export named bindings and no default export.
 *
 * The CommonJS build converts each source file with esbuild in Node interop
 * mode. There a default import of a sibling module resolves to that module's
 * whole exports object (`{ __esModule, default }`) instead of the Effect, so
 * `set.migrations["0001_initial"].pipe` was undefined under `require` while
 * the ESM build kept working. A named export has one shape in both formats,
 * and the second case here fails as soon as a default export comes back.
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import * as Initial from "../src/migrations/0001_initial.ts"
import * as SelectionStore from "../src/migrations/0002_selection_store.ts"
import * as PlanInputs from "../src/migrations/0003_plan_inputs.ts"
import * as PlanEnvironment from "../src/migrations/0004_plan_environment.ts"
import * as PlanMerges from "../src/migrations/0005_plan_merges.ts"
import * as ExecutionListing from "../src/migrations/0006_execution_listing.ts"
import * as RunParentSequence from "../src/migrations/0007_run_parent_sequence.ts"
import * as DeferredConsumption from "../src/migrations/0008_deferred_consumption.ts"
import * as DeferredClockFacts from "../src/migrations/0009_deferred_clock_facts.ts"

describe("migration modules", () => {
  it("registers an Effect for every migration in the set", () => {
    const entries = Object.entries(Migrations.set.migrations)
    expect(entries.map(([id]) => id)).toEqual([
      "0001_initial",
      "0002_selection_store",
      "0003_plan_inputs",
      "0004_plan_environment",
      "0005_plan_merges",
      "0006_execution_listing",
      "0007_run_parent_sequence",
      "0008_deferred_consumption",
      "0009_deferred_clock_facts"
    ])
    for (const [id, migration] of entries) {
      expect(Effect.isEffect(migration), id).toBe(true)
      expect(typeof migration.pipe, id).toBe("function")
    }
    expect(Migrations.set.migrations["0001_initial"]).toBe(Initial.initial)
    expect(Migrations.set.migrations["0002_selection_store"]).toBe(SelectionStore.selectionStore)
    expect(Migrations.set.migrations["0003_plan_inputs"]).toBe(PlanInputs.planInputs)
    expect(Migrations.set.migrations["0004_plan_environment"]).toBe(PlanEnvironment.planEnvironment)
    expect(Migrations.set.migrations["0005_plan_merges"]).toBe(PlanMerges.planMerges)
    expect(Migrations.set.migrations["0006_execution_listing"]).toBe(ExecutionListing.executionListing)
    expect(Migrations.set.migrations["0007_run_parent_sequence"]).toBe(RunParentSequence.runParentSequence)
    expect(Migrations.set.migrations["0008_deferred_consumption"]).toBe(DeferredConsumption.deferredConsumption)
    expect(Migrations.set.migrations["0009_deferred_clock_facts"]).toBe(DeferredClockFacts.deferredClockFacts)
  })

  it("exports each migration as a named binding and no default", () => {
    expect("default" in Initial).toBe(false)
    expect("default" in SelectionStore).toBe(false)
    expect(Object.keys(Initial)).toEqual(["initial"])
    expect(Object.keys(SelectionStore)).toEqual(["selectionStore"])
    expect(typeof Initial.initial.pipe).toBe("function")
    expect(typeof SelectionStore.selectionStore.pipe).toBe("function")
    expect(Object.keys(PlanInputs)).toEqual(["planInputs"])
    expect(Object.keys(PlanEnvironment)).toEqual(["planEnvironment"])
    expect(Object.keys(PlanMerges)).toEqual(["planMerges"])
    expect(Object.keys(ExecutionListing)).toEqual(["executionListing"])
    expect(Object.keys(RunParentSequence)).toEqual(["runParentSequence"])
    expect(Object.keys(DeferredConsumption)).toEqual(["deferredConsumption"])
    expect(Object.keys(DeferredClockFacts)).toEqual(["deferredClockFacts"])
  })
})
