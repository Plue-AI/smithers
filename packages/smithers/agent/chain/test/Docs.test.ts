import type { Effect } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Author from "../src/Author.ts"
import * as Authorize from "../src/Authorize.ts"
import * as Chain from "../src/Chain.ts"
import * as chain from "../src/index.ts"
import * as Journal from "../src/Journal.ts"
import * as JsonBoundary from "../src/JsonBoundary.ts"
import type * as Outcome from "../src/Outcome.ts"
import * as Prompt from "../src/Prompt.ts"
import * as QuickJsRunner from "../src/QuickJsRunner.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import * as Steering from "../src/Steering.ts"
import * as SubChains from "../src/SubChains.ts"

// The package owns its own prose (see docs/README.md). Nothing generates
// these files, so this is the gate that keeps them honest: a namespace added
// to the barrel, a default changed in the source, or a new dangling citation
// has to be answered in the same commit.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (...parts: ReadonlyArray<string>): string => readFileSync(join(packageRoot, ...parts), "utf8")

const api = read("docs", "api.md")
const contract = read("docs", "contract.md")
const readme = read("README.md")
const installation = read("docs", "installation.md")
const manifest = JSON.parse(read("package.json")) as {
  readonly dependencies: { readonly effect: string }
  readonly engines: { readonly node: string }
}

describe("package documentation", () => {
  // dprint pads markdown table cells, so rows are read cell by cell rather
  // than matched as raw text.
  const cells = (document: string): ReadonlyArray<ReadonlyArray<string>> =>
    document.split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))

  const defaultOf = (label: string): string => {
    const found = cells(contract).find((row) => row[0] === label)
    if (found?.[1] === undefined) throw new Error(`docs/contract.md has no limits row for ${label}`)
    return found[1]
  }

  it("describes every namespace the barrel exports", () => {
    const described = new Set(cells(api).map((row) => row[0]))
    const missing = Object.keys(chain).filter((name) => !described.has(`\`${name}\``))
    expect(missing).toEqual([])
  })

  it.each([
    ["README.md"],
    ["docs", "README.md"],
    ["docs", "guides", "resume-and-replay.md"],
    ["docs", "contract.md"]
  ])("bounds the crash-safety promise in %s", (...parts) => {
    const document = read(...parts).replace(/\s+/g, " ")
    expect(document).toContain(
      "Chain provides exactly-once replay of journaled settled calls and at-least-once handler execution."
    )
    expect(document).toContain(
      "If a handler succeeds but a crash or append failure prevents `CallSettled` from being recorded, resume can execute the handler again."
    )
    expect(document).toContain(
      "Handlers must be idempotent or, for non-repeatable effects, use an external durable idempotency key derived from the stable call identity (`chain`, `link`, `ordinal` in `Catalog.CallSlot`)."
    )
    expect(document).not.toContain("without repeating a single side effect")
    expect(document).not.toContain("Resume with zero repeated effects")
  })

  it("states the resource limits the source actually carries", () => {
    const memoryBytes = QuickJsRunner.defaultLimits.memoryBytes ?? 0
    expect(defaultOf("QuickJS realm memory")).toBe(
      `${memoryBytes / 1024 / 1024} MiB, floored at ${QuickJsRunner.memoryFloor / 1024} KiB`
    )
    const stackBytes = QuickJsRunner.defaultLimits.stackBytes ?? 0
    expect(defaultOf("QuickJS in-realm stack")).toBe(
      `${stackBytes / 1024} KiB, capped at ${QuickJsRunner.stackCeiling / 1024} KiB`
    )
    expect(defaultOf("QuickJS interrupt polls")).toBe(String(QuickJsRunner.defaultLimits.steps))
    expect(defaultOf("JSON boundary depth")).toBe(String(JsonBoundary.maxJsonDepth))
    expect(defaultOf("JSON boundary size budget")).toBe(
      `${JsonBoundary.maxJsonSize / 1024 / 1024} MiB in nodes plus string code units`
    )
    expect(defaultOf("Catalog entry name in the prompt")).toBe(`${Prompt.maxEntryName} characters`)
    expect(defaultOf("Catalog entry description in the prompt")).toBe(
      `${Prompt.maxEntryDescription} characters`
    )
    expect(defaultOf("Links per chain")).toBe(String(Chain.defaultMaxLinks))
    expect(defaultOf("Calls per link")).toBe(String(Chain.defaultMaxCallsPerLink))
    expect(defaultOf("Sub-chain nesting depth")).toBe(String(SubChains.defaultMaxDepth))
  })

  // `README.md` and `docs/README.md` each repeat the whole limits paragraph
  // in prose. Neither is generated, so every number in both copies is read
  // out of the constant that carries it.
  it.each([
    ["README.md"],
    ["docs", "README.md"]
  ])("pins every number in the limits paragraph of %s", (...parts) => {
    const document = read(...parts).replace(/\s+/g, " ")
    const memoryBytes = QuickJsRunner.defaultLimits.memoryBytes ?? 0
    const stackBytes = QuickJsRunner.defaultLimits.stackBytes ?? 0
    const fragments = [
      `${Chain.defaultMaxLinks} links per chain`,
      `${Chain.defaultMaxCallsPerLink} calls per link`,
      `${SubChains.defaultMaxDepth} levels of sub-chain nesting`,
      `${memoryBytes / 1024 / 1024} MiB QuickJS heap`,
      `${stackBytes / 1024} KiB stack`,
      `${QuickJsRunner.defaultLimits.steps}-poll step budget`,
      `JSON boundary bounded at depth ${JsonBoundary.maxJsonDepth}`,
      `${JsonBoundary.maxJsonSize / 1024 / 1024} MiB size budget`
    ]
    expect(fragments.filter((fragment) => !document.includes(fragment))).toEqual([])
  })

  // Four documents quote the size of the barrel. The count is a mirror of
  // `index.ts` with nothing generating it, so it is read out of the barrel.
  it("pins the namespace count every document repeats", () => {
    const count = Object.keys(chain).length
    const stale = ([
      ["README.md"],
      ["docs", "README.md"],
      ["docs", "api.md"],
      ["docs", "quickstart.md"]
    ] as ReadonlyArray<ReadonlyArray<string>>)
      .filter((parts) => !read(...parts).includes(`${count} namespaces`))
      .map((parts) => parts.join("/"))
    expect(stale).toEqual([])
  })

  // `docs/installation.md` quotes the runtime and the one direct dependency
  // a reader has to have. Both are pinned in `package.json`.
  it("pins the versions docs/installation.md quotes to package.json", () => {
    expect(installation).toContain(`Node.js ${manifest.engines.node.replace(/^>=/, "")} or later`)
    expect(installation).toContain(`Effect](https://effect.website) ${manifest.dependencies.effect}.`)
  })

  // `docs/api.md` gives every namespace one `## \`Name\`` section and opens a
  // bullet per member. Nothing generates those sections, so a member added
  // to a module has to be answered here. Type-only exports carry no runtime
  // key and are out of this gate's reach.
  it("documents every runtime member under its namespace heading", () => {
    const sections = new Map(
      api.split(/^## /m).slice(1)
        .map((block) => [block.slice(0, block.indexOf("\n")).trim(), block] as const)
        .filter(([heading]) => heading.startsWith("`"))
        .map(([heading, block]) => [heading.slice(1, -1), block] as const)
    )
    const undocumented = Object.entries(chain).flatMap(([namespace, members]) => {
      const section = sections.get(namespace)
      if (section === undefined) return [`${namespace} (no section)`]
      return Object.keys(members as object)
        .filter((member) => !new RegExp(`^- \`${member}\\b`, "m").test(section))
        .map((member) => `${namespace}.${member}`)
    })
    expect(undocumented).toEqual([])
  })

  // Read out of the schemas, not transcribed: a code added to or removed
  // from any of these unions changes what the contract has to name.
  // `Schema.Literals` carries `literals`, `Schema.Literal` carries `literal`,
  // and either wrapped in `withConstructorDefault` carries the wrapped schema
  // under `schema`. An unreadable field throws rather than silently
  // contributing nothing, which would turn this gate into a no-op.
  const codesOf = (name: string, error: unknown): ReadonlyArray<string> => {
    type Union = {
      readonly literal?: string
      readonly literals?: ReadonlyArray<string>
      readonly schema?: Union
    }
    const code = (error as { readonly fields: { readonly code: Union } }).fields.code
    const read = (union: Union | undefined): ReadonlyArray<string> | undefined =>
      union === undefined
        ? undefined
        : union.literals ?? (union.literal === undefined ? read(union.schema) : [union.literal])
    const literals = read(code)
    if (literals === undefined || literals.length === 0) {
      throw new Error(`${name} no longer exposes its code literals; the docs gate cannot read them`)
    }
    return literals
  }

  it("names every stable error code the contract promises", () => {
    const codes = [
      ...codesOf("ChainError", Chain.ChainError),
      ...codesOf("JournalError", Journal.JournalError),
      ...codesOf("AuthorError", Author.AuthorError),
      ...codesOf("AuthorizeError", Authorize.AuthorizeError),
      ...codesOf("SteeringError", Steering.SteeringError),
      ...codesOf("ScriptFailure", ScriptRunner.ScriptFailure)
    ]
    const unnamed = codes.filter((code) => !contract.includes(`\`${code}\``))
    expect(unnamed).toEqual([])
  })

  // The npm README is a reader's front page, not a maintainer's map, so it
  // links the published site rather than the source files under `docs/`.
  it("keeps the README pointing at the published documentation", () => {
    expect(readme).toContain("https://chain.smithers.sh")
    expect(readme).toContain("https://chain.smithers.sh/reference/api/")
    expect(readme).toContain("https://chain.smithers.sh/contract/")
  })

  // Neither `Chain` nor `ModelAuthor` supplies a prompt: `Chain.run` defaults
  // `prefix` to "" and `ModelAuthor` emits no system part for it. Every
  // model-backed composition the docs show must therefore hand the model
  // the flow contract and the mounted catalog through `Prompt.forCatalog`.
  it.each([
    ["docs", "api.md"],
    ["docs", "quickstart.md"],
    ["README.md"]
  ])("hands the model a catalog prefix in the model-backed composition in %s", (...parts) => {
    const document = read(...parts)
    expect(document).toContain("ModelAuthor.layer(")
    expect(document).toContain("prefix: Prompt.forCatalog(catalog, \"concierge\")")
    expect(document).not.toContain("the same four layers drive a real agent")
  })

  // Both runners execute ordinary promise jobs; `ctx.call` is the only
  // EXTERNAL async operation. The failure is a still-pending script with no
  // runnable jobs and no queued catalog calls, never "any await that is not
  // ctx.call".
  it.each([
    ["docs", "concepts", "flow-scripts.md"],
    ["docs", "guides", "testing.md"],
    ["docs", "troubleshooting.md"]
  ])("scopes the pending-script failure to idle promises in %s", (...parts) => {
    const document = read(...parts).replace(/\s+/g, " ")
    expect(document).not.toContain("Awaiting anything other than `ctx.call` fails")
    expect(document).not.toContain("a promise outside `ctx.call` never settles")
    expect(document).not.toContain("awaited a promise outside `ctx.call`, which never settles")
    expect(document).toContain("no runnable jobs")
  })

  // `Chain` builds `[...context, ...promoted.map(line => \`[steering] ${line}\`)]`
  // (see test/Steering.test.ts), so drained lines follow the caller's context.
  it("orders promoted steering lines after the caller's context in the steering guide", () => {
    const document = read("docs", "guides", "steering.md").replace(/\s+/g, " ")
    expect(document).not.toContain("prepends each drained line")
    expect(document).toContain("appends each drained line to the author context")
    expect(document).toContain("`[\"fix TODOs\", \"[steering] ship it today\"]`")
  })

  it("leaves no source file citing a document this repository does not carry", () => {
    // Every module used to name a `docs/specs/Concepts/*.md` file as its
    // governing contract. That directory never came across with the package,
    // so the package's stated authority resolved to nothing for any reader.
    const sources = readdirSync(join(packageRoot, "src")).filter((name) => name.endsWith(".ts"))
    const dangling = sources.filter((name) => read("src", name).includes("docs/specs/"))
    expect(dangling).toEqual([])
  })

  it("states the run result and child-failure contract Chain.run implements", () => {
    expectTypeOf<Effect.Success<ReturnType<typeof Chain.run>>>().toEqualTypeOf<Outcome.RunResult>()
    const flat = api.replace(/\s+/g, " ")
    expect(flat).toContain("run(options: Options): Effect.Effect<Outcome.RunResult, RunError, Services>")
    expect(flat).toContain("`RunResult = Terminal | ApprovalWait`")
    expect(flat).toContain("including a script's own `park(\"approval\", ...)`, settle as data")
    expect(flat).toContain("Only a child's unsettled `ApprovalWait` bubbles")
    expect(flat).toContain("its original typed error reaches the parent's error channel")
    expect(flat).not.toMatch(/Effect\.Effect<Outcome\.Terminal,/)
    expect(flat).not.toMatch(/approval park bubbles|dies as a defect/)
  })
})
