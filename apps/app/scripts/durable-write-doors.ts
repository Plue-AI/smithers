/*
 * Every registered flow whose handler can reach a durable write, mechanically.
 *
 * The first sweep of this defect was done by reading the setup card and its
 * controller, and it missed `runs.open` — a button on that very card. A list
 * made by reading is a list of the doors somebody remembered. This one is made
 * by walking the two things that decide the answer:
 *
 *   1. `flows/entries/*.ts` declares every door a person can reach: a slash
 *      line, a palette pick, a card control. Each declaration names its
 *      handler as `actions.<member>`.
 *   2. `state/controller/*.ts` (plus AppController.ts) holds those members. A
 *      durable write is `.isPersisted.promise` — the only way this app waits
 *      for bytes — reached directly or through a helper in the same file.
 *
 * A member is attributed the writes of the nearest declaration above each
 * write site, then the call graph inside each file is followed (bounded, so a
 * cycle cannot spin) so helpers like `upsert` or `writeOrRefuse` carry their
 * writes up to the member that calls them.
 *
 * Run: bun run scripts/durable-write-doors.ts [--json]
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "src", "mainview")
const CONTROLLER = join(SRC, "state", "controller")
const ENTRIES = join(SRC, "flows", "entries")
const CARDS = join(SRC, "cards")

interface Declared {
  readonly file: string
  readonly name: string
  readonly line: number
  readonly end: number
  readonly indent: number
  readonly callable: boolean
}

/** Keywords a line can open with followed by `(`; none of them names a member. */
const STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  "if", "for", "while", "switch", "catch", "return", "await", "typeof", "void", "new", "throw", "yield", "delete"
])

const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)).map((file) => join(dir, file))

/**
 * Every `const name = …` / `function name(…)` in one file, with its indent and
 * the span it owns: up to the next declaration at the same depth or shallower,
 * which is what makes a member's body its own rather than its neighbour's.
 */
const declarations = (file: string): ReadonlyArray<Declared> => {
  const lines = readFileSync(file, "utf8").split("\n")
  const found: Array<Omit<Declared, "end">> = []
  lines.forEach((text, index) => {
    const declared = /^(\s*)(?:export\s+)?(?:async\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)/.exec(text)
    // A controller member is as often a property of the object the factory
    // returns (`openRun,` or `configureRepositorySetup: (id) => …`) as a
    // `const`. Both are declarations of the same thing to a person pressing it.
    const property = /^(\s*)([A-Za-z_$][\w$]*)\s*(?::\s*(?:async\s*)?\(|\()/.exec(text)
    // `if (…)`, `for (…)` and `await (…)` open a statement, not a member. Read
    // as one, a write inside an `if` became every `if`'s, and every member
    // whose body holds an `if (` inherited it.
    const match = declared ?? (property !== null && STATEMENT_KEYWORDS.has(property[2]!) ? null : property)
    if (match === null) return
    found.push({
      file, name: match[2]!, line: index + 1, indent: match[1]!.length,
      callable: /=>|\bfunction\b|=\s*async\b|:\s*(?:async\s*)?\(/.test(text)
    })
  })
  return found.map((declared, index) => {
    const closing = found.slice(index + 1).find((candidate) => candidate.indent <= declared.indent)
    return { ...declared, end: (closing?.line ?? lines.length + 1) - 1 }
  })
}

const writeSites = (file: string): ReadonlyArray<number> => {
  const lines = readFileSync(file, "utf8").split("\n")
  const sites: Array<number> = []
  lines.forEach((text, index) => { if (text.includes(".isPersisted.promise")) sites.push(index + 1) })
  return sites
}

/** name → the write sites it owns, after following calls inside its own file. */
const writersOf = (file: string): Map<string, Array<string>> => {
  const lines = readFileSync(file, "utf8").split("\n")
  const declared = declarations(file)
  const direct = new Map<string, Array<string>>()
  const indentOf = (line: number): number => /^\s*/.exec(lines[line - 1] ?? "")![0]!.length
  for (const site of writeSites(file)) {
    // The enclosing function, not the `const row = …` the write happens to sit under.
    const owner = [...declared].reverse().find((candidate) =>
      candidate.line <= site && candidate.end >= site && candidate.callable && candidate.indent < indentOf(site))
    if (owner === undefined) continue
    const held = direct.get(owner.name) ?? []
    held.push(`${file.slice(file.indexOf("apps/app"))}:${site}`)
    direct.set(owner.name, held)
  }
  // Follow calls inside the file so a helper's write reaches the member that calls it.
  const resolved = new Map(direct)
  for (let pass = 0; pass < 6; pass += 1) {
    for (const candidate of declared) {
      const body = lines.slice(candidate.line, candidate.end).join("\n")
      for (const [callee, sites] of resolved) {
        if (callee === candidate.name) continue
        if (!new RegExp(`\\b${callee}\\s*\\(`).test(body)) continue
        const held = resolved.get(candidate.name) ?? []
        const merged = [...new Set([...held, ...sites])]
        if (merged.length !== held.length) resolved.set(candidate.name, merged)
      }
    }
  }
  return resolved
}

/** Every declared flow, with the controller members its handler calls. */
export interface Door {
  readonly flow: string
  readonly file: string
  readonly line: number
  readonly members: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly control: boolean
}

/** Every declared flow, including the ones that reach no durable write. */
export const declaredDoors = (): ReadonlyArray<Door> => {
  const writers = new Map<string, Array<string>>()
  for (const file of [...sources(CONTROLLER), join(SRC, "state", "AppController.ts")]) {
    for (const [name, sites] of writersOf(file)) {
      writers.set(name, [...new Set([...(writers.get(name) ?? []), ...sites])])
    }
  }
  const controls = new Set<string>()
  for (const file of [...sources(CARDS), ...sources(SRC)]) {
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(/(?:onRunCommand|runCommand)\(\s*"([\w.-]+)"/g)) controls.add(match[1]!)
    for (const match of text.matchAll(/flowAction\(\s*onRunCommand\s*,\s*"([\w.-]+)"/g)) controls.add(match[1]!)
  }
  const doors: Array<Door> = []
  for (const file of sources(ENTRIES)) {
    const lines = readFileSync(file, "utf8").split("\n")
    lines.forEach((text, index) => {
      const named = /name:\s*"([\w.-]+)"/.exec(text)
      if (named === null) return
      // The declaration runs to the next `name:` or the end of the literal.
      const next = lines.findIndex((candidate, at) => at > index && /name:\s*"[\w.-]+"/.test(candidate))
      const body = lines.slice(index, next === -1 ? lines.length : next).join("\n")
      const members = [...new Set([...body.matchAll(/\bactions\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!))]
      const writes = [...new Set(members.flatMap((member) => writers.get(member) ?? []))]
      doors.push({
        flow: named[1]!, file: file.slice(file.indexOf("apps/app")), line: index + 1,
        members, writes, control: controls.has(named[1]!)
      })
    })
  }
  return doors
}

/**
 * THE ENUMERATION, as a value.
 *
 * The roll call of doors a test walks, read from here rather than from a list
 * somebody typed, so a door declared tomorrow is walked tomorrow
 * (state/DurableWriteDoorLines.test.ts). It is COVERAGE. It is not by itself
 * evidence for a property: R104e ran that file's admit-seam drive over the 201
 * declared flows this filter EXCLUDES and 194 behaved identically, and its
 * overlap drive never reads the door's name at all. What a walk over this list
 * is worth is stated per layer in that file's header.
 */
export const durableWriteDoors = (): ReadonlyArray<Door> =>
  declaredDoors().filter((door) => door.writes.length > 0)

if (import.meta.main) {
  const doors = declaredDoors()
  if (process.env.DBG) console.log("doors", doors.slice(0, 3))
  const writing = doors.filter((door) => door.writes.length > 0)
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(writing, null, 2))
  } else {
    console.log(`| flow | rendered as a control | handler | durable write |`)
    console.log(`| --- | --- | --- | --- |`)
    for (const door of [...writing].sort((a, b) => a.flow.localeCompare(b.flow))) {
      console.log(`| \`${door.flow}\` | ${door.control ? "yes" : "slash or palette only"} | ${door.members.join(", ")} | ${door.writes.join(" · ")} |`)
    }
    console.log(`\n${writing.length} of ${doors.length} declared flows reach a durable write; ${writing.filter((door) => door.control).length} of those are rendered as a control.`)
  }
}
