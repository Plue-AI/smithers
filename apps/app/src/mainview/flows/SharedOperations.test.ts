/* Shared wiki declarations retain their schema and rules when bound to the GUI. */
import { describe, expect, test } from "bun:test"
import { wikiOperations, wikiSurfaceOperations } from "@smthrs/ui/app-operations/wiki"
import { bind, type AppOperation, type CommandActions } from "./entries/Declare"
import { wikiFlows, wikiSurfaceFlows } from "./entries/wiki"
import { nameOf } from "./registry"

/** Handlers are never called here: binding reads only the declarations. */
const unused = {} as CommandActions

const all = [...wikiSurfaceFlows(unused), ...wikiFlows(unused)]
const bound = all.filter(entry => nameOf(entry) !== "wiki.save")
const shared: ReadonlyArray<AppOperation> = [...wikiSurfaceOperations, ...wikiOperations].filter(operation => operation.name !== "wiki.ask")

describe("GUI wiki flows", () => {
  test("register exactly the retained shared operations, in their order", () => {
    expect(all.map(nameOf)).toEqual([...shared.map((declared) => declared.name), "wiki.save"])
  })

  test("the public wiki question operation remains available without an app door", () => {
    expect(wikiOperations.some(operation => operation.name === "wiki.ask")).toBe(true)
    expect(bound.map(nameOf)).not.toContain("wiki.ask")
  })

  test("take their input schema from the shared declaration", () => {
    bound.forEach((entry, index) => expect(entry.input).toBe(shared[index]!.input))
  })

  test("carry the shared rules as their catalog metadata", () => {
    bound.forEach((entry, index) => {
      const { name: _name, input: _input, userOnly: _userOnly, ...rules } = shared[index]!
      expect(entry.metadata).toEqual(rules)
    })
  })

  test("disclose to the model exactly the operations that are not user-only", () => {
    bound.forEach((entry, index) =>
      expect(entry.binding.descriptor.modelInvocable).toBe(shared[index]!.userOnly !== true))
  })
})

describe("bind", () => {
  test("rejects a handler map that misses an operation or names one that does not exist", () => {
    const stale = { wiki: () => {}, "wiki.obsolete": () => {} }
    const check = () => {
      // @ts-expect-error: a handler for a removed operation does not compile
      bind(wikiSurfaceOperations, stale)
      // @ts-expect-error: an operation without a handler does not compile
      bind(wikiSurfaceOperations, {})
    }
    expect(typeof check).toBe("function")
  })

  test("throws when a list widened past its names reaches an operation without a handler", () => {
    const widened: ReadonlyArray<AppOperation> = wikiSurfaceOperations
    expect(() => bind(widened, {})).toThrow("No GUI handler for the wiki operation.")
  })
})
