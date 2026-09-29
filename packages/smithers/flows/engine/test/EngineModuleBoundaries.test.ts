import { describe, expect, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
import { ExecutionIdentityConflict } from "../src/FlowEngine/layerMemory.ts"
import { SnapshotBoundaryRequired } from "../src/FlowEngine/SnapshotBoundary.ts"
import { FlowNotRegistered, SuspendedResumeGaveUp } from "../src/FlowEngine/Trampoline.ts"
import { FlowEngine } from "../src/index.ts"

const at = (path: string) => new URL(path, import.meta.url)
const read = (path: string) => readFileSync(at(path), "utf8")

// Every coded refusal, the module that must declare it, and the tag the
// barrel publishes it under. A refusal is classifiable only by its tag, so a
// move that changes the tag is a breaking change even though the class name
// survives it.
const refusals = [
  {
    name: "SuspendedResumeGaveUp",
    owner: "../src/FlowEngine/Trampoline.ts",
    tag: "@smthrs/engine/SuspendedResumeGaveUp",
    declared: SuspendedResumeGaveUp
  },
  {
    name: "FlowNotRegistered",
    owner: "../src/FlowEngine/Trampoline.ts",
    tag: "@smthrs/engine/FlowNotRegistered",
    declared: FlowNotRegistered
  },
  {
    name: "SnapshotBoundaryRequired",
    owner: "../src/FlowEngine/SnapshotBoundary.ts",
    tag: "@smthrs/engine/SnapshotBoundaryRequired",
    declared: SnapshotBoundaryRequired
  },
  {
    name: "ExecutionIdentityConflict",
    owner: "../src/FlowEngine/layerMemory.ts",
    tag: "@smthrs/engine/ExecutionIdentityConflict",
    declared: ExecutionIdentityConflict
  }
] as const

describe("engine module boundaries", () => {
  it("keeps no Errors.ts grab-bag", () => {
    expect(existsSync(at("../src/FlowEngine/Errors.ts"))).toBe(false)
  })

  it.each(refusals)("declares $name in its owner module under $tag", ({ name, owner, tag }) => {
    const source = read(owner)
    expect(source).toContain(`export class ${name} extends`)
    expect(source).toContain(`"${tag}"`)
  })

  it.each(refusals)("publishes the owner module's $name from the barrel", ({ declared, name }) => {
    expect(FlowEngine[name]).toBe(declared)
  })

  it("leaves make.ts holding the adapter alone", () => {
    const make = read("../src/FlowEngine/make.ts")
    // The trampoline round loop and the action dispatch guard each own a
    // module now, so neither the loop's dispatch helper nor the dispatch
    // wrapper's allocation scope may be declared here.
    expect(make).not.toContain("const runRound")
    expect(make).not.toContain("ActionOrdinalScope")
    expect(make).toContain("execute: placeExecute(makeExecute(options, declarations))")
    expect(make).toContain("actionExecute: makeActionExecute(options)")
    expect(make.split("\n").length).toBeLessThan(300)
  })

  it("passes the dispatch allocation scope lexically, not through context", () => {
    const dispatch = read("../src/FlowEngine/Dispatch.ts")
    // A private context service once carried the one derived scope from the
    // concurrency guard to the ordinal allocator in the same function.
    expect(dispatch).not.toContain("ActionOrdinalScope")
    expect(dispatch).not.toContain("Context.Service")
    expect(dispatch).toContain("dispatch(action, attempt, scope)")
  })

  it("carries the trampoline round state as one value, unshadowed", () => {
    const trampoline = read("../src/FlowEngine/Trampoline.ts")
    // The four `let round*` bindings were re-declared as `runRound`
    // parameters of the same names, so a reader could not tell which binding
    // a round identity came from. One replaced-whole record removes the
    // shadowing outright.
    for (const shadowed of ["let round ", "let roundFlow", "let roundExecutionId", "let roundPayload"]) {
      expect(trampoline).not.toContain(shadowed)
    }
    expect(trampoline).toContain("let lineage: LineageRound")
  })
})
