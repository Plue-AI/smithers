import { describe, expect, it } from "bun:test"
import * as Contributions from "../src/contributions.ts"
import * as Extension from "../src/extension.ts"
import * as Keys from "../src/keys.ts"

const store = () => new Contributions.Store({ taken: Keys.taken })
const agent = (name: string, tui: unknown): Extension.Descriptor => ({
  name,
  description: name,
  modelInvocable: true,
  kind: "markdown",
  flows: [],
  capabilities: [],
  path: `flows/${name}/flow.mdx`,
  tui
})
const status = (id: string, text = id): Extension.Contribution => ({ kind: "status", status: { id, text } })
const key = (id: string, value: string, context?: "global" | "panel"): Extension.Contribution => ({
  kind: "key",
  key: {
    id,
    key: value,
    label: id,
    action: { kind: "prompt", prompt: id },
    ...(context === undefined ? {} : { context })
  }
})

describe("contributions store", () => {
  it("replaces every repo contribution atomically on each listing", () => {
    const contributions = store()
    let changes = 0
    contributions.subscribe(() => changes++)
    contributions.repo([
      Extension.declared(agent("review", { keys: [{ key: "alt+z", label: "Review" }], status: true, card: true })),
      Extension.declared(agent("release", { keys: [{ key: "alt+l", label: "Release" }] }))
    ])
    expect(contributions.snapshot().keys.map((each) => each.key.key)).toEqual(["alt+z", "alt+l"])
    expect(contributions.snapshot().cards).toEqual(["review"])
    expect(contributions.snapshot().watched).toEqual(["review"])
    contributions.repo([Extension.declared(agent("release", { keys: [{ key: "alt+n", label: "Release" }] }))])
    expect(contributions.snapshot().keys.map((each) => `${each.owner} ${each.key.key}`)).toEqual(["repo:release alt+n"])
    expect(contributions.snapshot().cards).toEqual([])
    // An identical listing changes nothing, so a subscriber that re-lists cannot loop.
    const before = changes
    contributions.repo([Extension.declared(agent("release", { keys: [{ key: "alt+n", label: "Release" }] }))])
    expect(changes).toBe(before)
  })

  it("holds the limits: 8 keys per owner, 24 status items, global keys need a modifier", () => {
    const contributions = store()
    for (let n = 1; n <= 8; n++) contributions.runtime("runtime:chat", key(`k${n}`, `alt+${n}`))
    expect(() => contributions.runtime("runtime:chat", key("k9", "alt+9"))).toThrow("8 keys")
    // Republishing an id replaces it, so it never counts twice.
    contributions.runtime("runtime:chat", key("k1", "alt+0"))
    expect(contributions.snapshot().keys).toHaveLength(8)
    for (let n = 0; n < 24; n++) contributions.runtime("runtime:chat", status(`s${n}`))
    expect(() => contributions.runtime("runtime:chat", status("s24"))).toThrow("24 status")
    contributions.runtime("runtime:chat", status("s0", "updated"))
    expect(contributions.snapshot().status.find((each) => each.status.id === "s0")?.status.text).toBe("updated")
    const refusal = (() => {
      try {
        contributions.runtime("runtime:tab", key("bare", "r"))
      } catch (error) {
        return error
      }
    })()
    expect(refusal).toBeInstanceOf(Contributions.Refusal)
    expect((refusal as Contributions.Refusal).code).toBe("invalid")
    expect((refusal as Error).message).toBe("Global key r needs ctrl or alt")
  })

  it("refuses a built-in key and a key another owner holds, with one line each", () => {
    const contributions = store()
    const refused = (value: Extension.Contribution, owner = "runtime:chat") => {
      try {
        contributions.runtime(owner, value)
      } catch (error) {
        return { code: (error as Contributions.Refusal).code, message: (error as Error).message }
      }
    }
    expect(refused(key("quit", "ctrl+c"))).toEqual({ code: "collision", message: "ctrl+c is the built-in Clear key" })
    // A panel key collides with the view's own keys, not with text typed in the composer.
    expect(refused(key("down", "j", "panel"))?.code).toBe("collision")
    expect(refused(key("go", "g", "panel"))).toBeUndefined()
    contributions.repo([Extension.declared(agent("review", { keys: [{ key: "alt+z", label: "Review" }] }))])
    expect(refused(key("mine", "alt+z"))).toEqual({ code: "collision", message: "alt+z is taken by repo:review" })
    expect(contributions.snapshot().problems).toEqual([])
  })

  it("collects repo problems: a bad manifest, a built-in key and a key two flows declare", () => {
    const contributions = store()
    contributions.repo([
      Extension.declared(agent("broken", { keys: [{ key: "r", label: "Bare" }] })),
      Extension.declared(agent("clear", { keys: [{ key: "ctrl+c", label: "Clear" }] })),
      Extension.declared(agent("first", { keys: [{ key: "alt+g", label: "First" }] })),
      Extension.declared(agent("second", { keys: [{ key: "alt+g", label: "Second" }] }))
    ])
    const { problems, keys } = contributions.snapshot()
    expect(keys.map((each) => each.owner)).toEqual(["repo:first"])
    expect(problems).toHaveLength(3)
    expect(problems[0]).toStartWith("broken: ")
    expect(problems.slice(1)).toEqual([
      "clear: ctrl+c is the built-in Clear key",
      "second: alt+g is taken by repo:first"
    ])
    expect(problems.every((problem) => !problem.includes("\n"))).toBe(true)
  })

  it("lets built-in plugins place panels and replaces a plugin's set as a whole", () => {
    const contributions = store()
    const panel = { id: "smithers", title: "Smithers", summary: "Two flows.", rows: [] }
    contributions.plugin("smithers", [{ kind: "panel", placement: "tab", panel }, status("flows")])
    expect(contributions.snapshot().panels).toEqual([{ owner: "plugin:smithers", placement: "tab", panel }])
    expect(contributions.snapshot().status.map((each) => each.owner)).toEqual(["plugin:smithers"])
    let changes = 0
    contributions.subscribe(() => changes++)
    contributions.plugin("smithers", [{ kind: "panel", placement: "tab", panel }, status("flows")])
    expect(changes).toBe(0)
    contributions.plugin("smithers", [])
    expect(changes).toBe(1)
    expect(contributions.snapshot().panels).toEqual([])
    expect(contributions.snapshot().status).toEqual([])
  })

  it("resolves repo status items from live state and forgets runtime items with the session", () => {
    const contributions = store()
    contributions.repo([Extension.declared(agent("review", { status: true }))])
    contributions.runtime("runtime:chat", status("ci", "CI ✓"))
    const live = (name: string): Extension.Status | undefined =>
      name === "review" ? { id: "review", text: "◌ review", action: { kind: "open", surface: "flow:r1" } } : undefined
    expect(contributions.snapshot(live).status.map((each) => `${each.owner} ${each.status.text}`)).toEqual([
      "repo:review ◌ review",
      "runtime:chat CI ✓"
    ])
    expect(contributions.snapshot().status.map((each) => each.owner)).toEqual(["runtime:chat"])
    contributions.clearRuntime()
    expect(contributions.snapshot().status).toEqual([])
  })
})
