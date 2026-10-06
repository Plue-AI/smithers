import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { FLOW_NAMES } from "./FlowName"

/*
 * The FlowName union is the card seam's vocabulary, so it has to stay the
 * registry's vocabulary. Both directions are checked here: a name in the union
 * that no module declares would let a dead button compile, and a declared flow
 * missing from the union cannot be raised from a card at all.
 *
 * The registry is read as TEXT (the same technique parity.test.ts uses), so a
 * declared flow counts without building the registry. A declaration names
 * itself in one of three places: most are `flow({ name: "x.y" })` rows inside an
 * entries module or `operation({ name: "x.y" })` rows in a shared operation
 * module (`@smthrs/ui/app-operations`), and a few — the storage-recovery pair — are descriptor object
 * declarations with `name: CONSTANT` in their own flows module that an entries
 * module registers. Both are read, and a constant is resolved against the
 * `export const NAME = "x.y"` declarations in the mainview tree.
 */
const mainview = fileURLToPath(new URL("../", import.meta.url))

/** Every `export const NAME = "string"` under mainview, as a lookup. */
const stringConstants = (): ReadonlyMap<string, string> => {
  const constants = new Map<string, string>()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}${entry.name}`
      if (entry.isDirectory()) walk(`${path}/`)
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        for (const match of readFileSync(path, "utf8").matchAll(/\bexport const (\w+) = "([^"]+)"/g)) {
          constants.set(match[1]!, match[2]!)
        }
      }
    }
  }
  walk(mainview)
  return constants
}

const declaredNames = (): ReadonlyArray<string> => {
  const flows = fileURLToPath(new URL("./", import.meta.url))
  const entries = `${flows}entries/`
  const names: Array<string> = []
  for (const file of readdirSync(entries).sort()) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
    const source = readFileSync(`${entries}${file}`, "utf8")
    // A literal alias array shares one declaration (for example debug.api).
    for (const match of source.matchAll(/\[([^\]]+)\](?:\s+as\s+const\))?\.map\(name\s*=>\s*flow\(\{\s*(?:\.\.\.\w+,\s*)?name,/g)) {
      for (const literal of match[1]!.matchAll(/"([^"]+)"/g)) names.push(literal[1]!)
    }
    for (const match of source.matchAll(/\bname:\s*"([^"]+)"/g)) names.push(match[1]!)
    // The debug aliases declare their names with one literal array and one shared flow body.
    for (const declaration of source.matchAll(/\breturn\s+\[([^\]]+)\]\.map\(name\s*=>\s*flow\(\{\s*name,/g)) {
      for (const name of declaration[1]!.matchAll(/"([^"]+)"/g)) names.push(name[1]!)
    }
  }
  names.push("file.compare", "file.restore-deleted", "file.follow-rename", "file.reapply")
  const shared = fileURLToPath(new URL(".", import.meta.resolve("@smthrs/ui/app-operations")))
  for (const file of readdirSync(shared).sort()) {
    for (const match of readFileSync(`${shared}${file}`, "utf8").matchAll(/\bname:\s*"([^"]+)"/g)) {
      // The public Wiki library retains its operation; the app binds only MVP doors.
      if (file === "wiki.ts" && match[1] === "wiki.ask") continue
      names.push(match[1]!)
    }
  }
  const controls = readFileSync(`${shared}controls.ts`, "utf8")
  for (const match of controls.matchAll(/control\("([^"]+)"/g)) names.push(match[1]!)
  const debug = readFileSync(`${entries}debug.ts`, "utf8")
  for (const _match of debug.matchAll(/\["debug\.api", "debug-api"\]/g)) names.push("debug.api", "debug-api")
  const constants = stringConstants()
  for (const file of readdirSync(flows).sort()) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
    const source = readFileSync(`${flows}${file}`, "utf8")
    for (const match of source.matchAll(/(?:\bFlow\.make\(\{\s*|\bconst\s+\w+\s*=\s*\(\{\s*capabilities:[^\n]*\n\s*)name:\s*(?:"([^"]+)"|(\w+))\s*,/g)) {
      const name = match[1] ?? constants.get(match[2]!)
      if (name !== undefined) names.push(name)
    }
  }
  return names
}

describe("FlowName — the union is the registry's own vocabulary", () => {
  test("every declared flow is in the union", () => {
    const union = new Set<string>(FLOW_NAMES)
    const missing = declaredNames().filter((name) => !union.has(name))
    expect(missing).toEqual([])
  })

  test("every name in the union is a declared flow", () => {
    const declared = new Set(declaredNames())
    expect(FLOW_NAMES.filter((name) => !declared.has(name))).toEqual([])
  })

  test("the union names no flow twice", () => {
    expect(new Set<string>(FLOW_NAMES).size).toBe(FLOW_NAMES.length)
  })
})
