import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Keys from "../src/keys.ts"
import * as Tabs from "../src/tabs.ts"

const read = (file: string) => readFileSync(join(import.meta.dir, "../src", file), "utf8")
const app = read("app.tsx")
/** The key layers the app dispatches through, and the composer's own bindings. */
const dispatch = read("key-dispatch.ts")
const composer = read("composer.ts")

/** A key literal a handler compares against, with whether Ctrl must be held. */
interface Handled {
  readonly name: string
  readonly ctrl: boolean
  readonly at: string
}

const literal = String.raw`"(?:[^"\\]|\\.)*"`
const ctrlBefore = String.raw`(key\.ctrl\s*&&\s*\(?\s*)?`
/** Every way the handlers name a key; a shape outside these fails the guard below. */
const shapes = [
  new RegExp(String.raw`${ctrlBefore}key\.name\s*===\s*(${literal})`, "g"),
  new RegExp(String.raw`${ctrlBefore}\[((?:\s*${literal}\s*,?)+)\]\.includes\(key\.name\)`, "g")
]

const handled = (source: string, file: string): ReadonlyArray<Handled> =>
  shapes.flatMap((shape) =>
    [...source.matchAll(shape)].flatMap((match) =>
      [...match[2]!.matchAll(new RegExp(literal, "g"))].map((each) => ({
        name: JSON.parse(each[0]) as string,
        ctrl: match[1] !== undefined,
        at: `${file}: ${match[0]}`
      }))
    )
  )

/** Pure helpers take the name as a parameter and compare it or switch on it. */
const helper = (file: string, parameter: string): ReadonlyArray<Handled> =>
  [...read(file).matchAll(new RegExp(String.raw`(?:\b${parameter}\s*===|\bcase)\s*(${literal})`, "g"))].map((
    match
  ) => ({
    name: JSON.parse(match[1]!) as string,
    ctrl: false,
    at: `${file}: ${match[0]}`
  }))

const handlerKeys = (source: string): ReadonlyArray<Handled> => [
  ...handled(source, "app.tsx"),
  ...handled(dispatch, "key-dispatch.ts"),
  ...helper("approvals.ts", "name"),
  ...helper("panels.ts", "key"),
  ...helper("scrubber.ts", "name")
]

const unregistered = (keys: ReadonlyArray<Handled>): ReadonlyArray<string> =>
  keys.filter(({ name, ctrl }) =>
    !Keys.registry.some((binding) =>
      binding.keys.some((spelling) => {
        const parts = spelling.split("+")
        // An unmarked comparison may sit under an outer `key.ctrl` test, so it matches either form.
        return Keys.normalizeName(parts.at(-1)!) === Keys.normalizeName(name) && (!ctrl || parts.includes("ctrl"))
      })
    )
  ).map(({ at }) => at)

/** `key.name` read outside a recognized comparison: passed on, never compared here. */
const passedOn = [
  "Approvals.key(key.name",
  "Panels.navigate(current, key.name",
  "Activity.move(monitored.activity, activeInspection.seq, key.name)",
  "panelScroll.current?.(key.name",
  "(at + (key.name",
  "\"]\" : key.name"
]
const strayReads = (source: string): ReadonlyArray<string> => {
  let rest = source
  for (const shape of shapes) rest = rest.replace(shape, "")
  for (const use of passedOn) rest = rest.split(use).join("")
  return rest.split("\n").filter((line) => line.includes("key.name")).map((line) => line.trim())
}

describe("key registry", () => {
  it("has no duplicate spelling in one context", () => {
    expect(Keys.duplicateKeys()).toEqual([])
  })

  it("keeps every label to three words", () => {
    expect(Keys.registry.every((binding) => binding.label.trim().split(/\s+/).length <= 3)).toBe(true)
  })

  it("registers every key a handler compares, with its Ctrl modifier", () => {
    const keys = handlerKeys(app)
    // Non-vacuous: the scan sees the tab keys that arrive through `.includes`.
    expect(keys.some(({ name, ctrl }) => name === "]" && ctrl)).toBe(true)
    expect(keys.some(({ name }) => name === "y")).toBe(true)
    expect(keys.some(({ name }) => name === "j")).toBe(true)
    expect(unregistered(keys)).toEqual([])
    expect(strayReads(app)).toEqual([])
    expect(strayReads(dispatch)).toEqual([])
  })

  it("fails for a handler key added without a binding", () => {
    const withCtrlA = app.replace(
      "if (key.ctrl && key.name === \"k\") {",
      "if (key.ctrl && key.name === \"a\") return\n    if (key.ctrl && key.name === \"k\") {"
    )
    expect(withCtrlA).not.toBe(app)
    expect(unregistered(handlerKeys(withCtrlA))).toEqual(["app.tsx: key.ctrl && key.name === \"a\""])

    const withArray = app.replace(
      "[\"right\", \"left\", \"]\", \"\\\\\"]",
      "[\"right\", \"left\", \"]\", \"\\\\\", \"b\"]"
    )
    expect(withArray).not.toBe(app)
    expect(unregistered(handlerKeys(withArray))).toEqual([expect.stringContaining("\"b\"")])

    const withSwitch = app.replace("useKeyboard(handleKey)", "switch (key.name) {}\n  useKeyboard(handleKey)")
    expect(strayReads(withSwitch)).toEqual(["switch (key.name) {}"])
  })

  it("lists only keys some handler compares", () => {
    const names = new Set([
      ...handlerKeys(app).map(({ name }) => Keys.normalizeName(name)),
      "?",
      "/",
      "@",
      "!",
      "shift+enter",
      "linefeed"
    ])
    const composerKeys = [...composer.matchAll(/\{ name: "([^"]+)"/g)].map((match) => match[1]!)
    // A worker tab dispatches its actions through `Keys.bindingFor`, never a literal.
    for (const action of Tabs.bindings) for (const spelling of action.keys) names.add(spelling)
    for (const name of composerKeys) names.add(Keys.normalizeName(name))
    const orphans = Keys.registry.flatMap((binding) =>
      binding.keys.filter((spelling) =>
        !names.has(Keys.normalizeName(spelling.split("+").at(-1)!)) && !names.has(spelling)
      )
    )
    expect(orphans).toEqual([])
  })

  it("covers the dispatch contexts and provides useful hints", () => {
    for (
      const context of [
        "composer",
        "working",
        "shell",
        "panel",
        "picker",
        "form",
        "approval",
        "selection",
        "completion"
      ] as const
    ) {
      expect(Keys.bindingsFor(context).length).toBeGreaterThan(0)
      expect(Keys.hintsFor(context).length).toBeGreaterThan(0)
    }
    expect(Keys.hintsFor("composer").map(Keys.primaryKey)).toEqual(["ctrl+k", "ctrl+s", "ctrl+]", "?"])
    expect(Keys.hintsFor("working").map(Keys.primaryKey)).toEqual(["esc", "enter", "alt+enter", "?"])
    expect(Keys.hintsFor("approval").map((binding) => binding.id)).toEqual(["allow", "deny", "allow-all"])
  })

  it("gives a panel's own keys to the footer, so the panel draws no key line", () => {
    const hints = (options: Parameters<typeof Keys.panelHints>[0]) =>
      Keys.panelHints(options).map((binding) => `${Keys.primaryKey(binding)} ${binding.label}`)
    expect(hints({})).toEqual(["esc Chat", "hjkl/arrows Navigate", "enter Expand row", "? Keys"])
    expect(hints({ retry: true, stop: true, undo: true, action: "Approve" })).toEqual([
      "r Resume",
      "x Stop",
      "u Undo changes",
      "a Approve",
      "esc Chat",
      "hjkl/arrows Navigate",
      "enter Expand row",
      "? Keys"
    ])
    expect(read("panel-view.tsx")).not.toMatch(/esc chat|r retry|x stop|u undo/)
  })

  it("matches the terminal forms the app dispatches", () => {
    expect(Keys.matches({ name: "p", ctrl: true, shift: true }, "ctrl+shift+p")).toBe(true)
    expect(Keys.matches({ name: "kpenter" }, "enter")).toBe(true)
    expect(Keys.bindingFor({ name: "]", ctrl: true })?.id).toBe("next-tab")
    expect(Keys.bindingFor({ name: "\\", ctrl: true })?.id).toBe("previous-tab")
    expect(Keys.bindingFor({ name: "?" }, "composer")?.id).toBe("keys")
    expect(Keys.bindingFor({ name: "y" }, "approval")?.id).toBe("allow")
  })
})

describe("transcript scrolling", () => {
  it("scrolls a line with shift+up and shift+down from any context", () => {
    expect(Keys.bindingFor({ name: "up", shift: true }, "composer")?.id).toBe("scroll-line")
    expect(Keys.bindingFor({ name: "down", shift: true }, "working")?.id).toBe("scroll-line")
    expect(Keys.bindingFor({ name: "up" }, "composer")?.id).not.toBe("scroll-line")
  })
})

describe("contributed keys", () => {
  const review = {
    owner: "repo:review",
    key: {
      id: "repo:review/alt+r",
      key: "alt+r",
      label: "Review",
      context: "global" as const,
      action: { kind: "flow" as const, flow: "review" }
    }
  }
  const merged = Keys.bindings([review])

  it("merges a contributed global key into the hints and the popup, grouped by owner", () => {
    expect(Keys.hintsFor("composer", merged).map((binding) => binding.id)).toContain("repo:review/alt+r")
    expect(Keys.hintsFor("global", merged).map((binding) => binding.id)).toContain("repo:review/alt+r")
    const popup = Keys.bindingsFor("composer", merged).find((binding) => binding.id === "repo:review/alt+r")
    expect(popup).toMatchObject({
      group: "review",
      label: "Review",
      owner: "repo:review",
      action: { kind: "flow", flow: "review" }
    })
    expect(Keys.hintsFor("composer")).toEqual(Keys.hintsFor("composer", Keys.registry))
  })

  it("dispatches the contributed binding from the merged list only", () => {
    expect(Keys.bindingFor({ name: "r", meta: true }, "composer", merged)?.id).toBe("repo:review/alt+r")
    expect(Keys.bindingFor({ name: "r", option: true }, "panel", merged)?.action).toEqual({
      kind: "flow",
      flow: "review"
    })
    expect(Keys.bindingFor({ name: "r", meta: true }, "composer")).toBeUndefined()
  })

  it("names the built-in binding a contributed key would shadow", () => {
    expect(Keys.taken("ctrl+c", "global")?.id).toBe("clear")
    // Spelling and modifier order do not hide a collision.
    expect(Keys.taken("shift+ctrl+p", "global")?.id).toBe("previous-model")
    expect(Keys.taken("j", "panel")?.id).toBe("navigate")
    expect(Keys.taken("alt+r", "global")).toBeUndefined()
    expect(Keys.taken("g", "panel")).toBeUndefined()
  })

  it("counts the composer's text-editing keys as built-in, so a contributed key never steals them", () => {
    // The app handles contributed keys before the composer sees the event, so these would otherwise be hijacked.
    for (
      const key of [
        "ctrl+a",
        "ctrl+e",
        "ctrl+w",
        "ctrl+u",
        "ctrl+b",
        "ctrl+f",
        "alt+b",
        "alt+f",
        "alt+d",
        "ctrl+-",
        "alt+shift+f"
      ]
    ) {
      expect(Keys.taken(key, "global")?.id).toBe("edit-text")
    }
    // They are not panel keys, and they stay out of the which-key popup.
    expect(Keys.taken("ctrl+a", "panel")).toBeUndefined()
    expect(Keys.bindingsFor("composer").map((binding) => binding.id)).not.toContain("edit-text")
  })

  it("lists every contributed key after the built-in hints and fits whole hints to the footer, ? last", () => {
    const keys = ["alt+1", "alt+2", "alt+3", "alt+4"].map((key, index) => ({
      owner: "repo:many",
      key: {
        id: `repo:many/${key}`,
        key,
        label: `Step ${index + 1}`,
        context: "global" as const,
        action: { kind: "flow" as const, flow: "many" }
      }
    }))
    const hints = Keys.hintsFor("composer", Keys.bindings(keys))
    // No cap: all four contributed keys follow the built-in four.
    expect(hints.map((binding) => binding.id).slice(4)).toEqual(keys.map((each) => each.key.id))
    const all = Keys.fit(hints, 1_000)
    expect(all).toEqual(hints)
    const width = (list: ReadonlyArray<Keys.Binding>) =>
      list.reduce((total, binding, index) => total + (index === 0 ? 0 : 2) + Keys.hintWidth(binding), 0)
    for (const columns of [0, 7, 20, 40, 60, 80, 100]) {
      const kept = Keys.fit(hints, columns)
      expect(width(kept)).toBeLessThanOrEqual(columns)
      // Priority order, and nothing clipped: every kept hint is a whole binding from the list.
      const withoutPopup = kept.filter((binding) => binding.id !== "keys")
      expect(withoutPopup).toEqual(hints.filter((binding) => binding.id !== "keys").slice(0, withoutPopup.length))
      if (
        kept.length < hints.length &&
        width(kept) + 2 + Keys.hintWidth(hints.find((binding) => binding.id === "keys")!) <= columns
      ) {
        expect(kept.at(-1)?.id).toBe("keys")
      }
    }
    // Room for the built-ins and one contributed key keeps `?` for the rest.
    const room = width([...hints.slice(0, 3), hints[4]!, hints[3]!])
    expect(Keys.fit(hints, room).map((binding) => binding.id)).toEqual([
      "palette",
      "summary",
      "next-tab",
      "repo:many/alt+1",
      "keys"
    ])
  })
})
