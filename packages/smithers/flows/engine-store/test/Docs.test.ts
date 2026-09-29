import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"

const readDoc = (path: string): string => readFileSync(new URL(`../docs/${path}`, import.meta.url), "utf8")

const packageRoot = new URL("../", import.meta.url)
const repoRoot = new URL("../../../../../", import.meta.url)

/** Every file under `directory` whose name ends in one of `extensions`. */
const sourceFiles = (directory: URL, extensions: ReadonlyArray<string>): Array<URL> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(new URL(`${entry.name}/`, directory), extensions)
      : extensions.some((extension) => entry.name.endsWith(extension))
      ? [new URL(entry.name, directory)]
      : []
  )

describe("documentation contracts", () => {
  it("guide describes actual transaction ordering", () => {
    const guide = readDoc("concepts/execution-facts.md").replace(/\s+/g, " ")
    expect(guide).toContain("Engine-state is the outer transaction and the journal write transaction is inside it")
    expect(guide).toContain("The memory state gate is released at SQL commit before post-commit journal work")
    expect(guide).not.toContain("Journal/SQL is the outer transaction")
  })

  it("cites only documentation pages that exist", () => {
    // A cited page is where a reader goes next. The retired docs/pages tree
    // left twenty citations pointing at nothing, including the operator
    // script's own procedure. Citations are backticked; quoted paths in
    // tests are fixtures, not citations.
    const files = ["src/", "scripts/", "test/"].flatMap((directory) =>
      sourceFiles(new URL(directory, packageRoot), [".ts", ".mjs"])
    )
    const dangling = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/`((?:packages\/[\w./-]+\/)?docs\/[\w./-]+\.mdx?)`/g)]
        .map((match) => match[1]!)
        .filter((cited) => !existsSync(new URL(cited, cited.startsWith("packages/") ? repoRoot : packageRoot)))
        .map((cited) => `${file.pathname.slice(packageRoot.pathname.length)}: ${cited}`)
    )
    expect(dangling).toEqual([])
  })

  it("describes the strict default and both explicit inconsistency layers", () => {
    const row = readDoc("guides/compose-a-durable-engine.md").split("\n")
      .find((line) => /^\|\s*`Inconsistency`\s*\|/.test(line))
    expect(row).toBeDefined()
    const cells = row!.split("|").map((cell) => cell.trim())
    expect(cells[2]).toContain("Conflicts are journaled and fail the dispatch (the strict default)")
    expect(cells[2]).toContain("`layerTolerant(owner)` to continue past them")
    expect(cells[3]).toContain("`layerStrict(owner)`")
    expect(cells[3]).toContain("`layerTolerant(owner)`")
  })

  it("documents the durable TTL removal refusal and recovery policy", () => {
    const api = readDoc("api.md").replace(/\s+/g, " ")
    expect(api).toContain("Omitting `ttlMs` is unbounded only before a durable age verdict exists")
    expect(api).toContain("Removing `ttlMs` after a recorded verdict fails with `idempotency_conflict`")
    expect(api).toContain(
      "Recovery must retain the original TTL and history identity, or use a new action or run identity"
    )
    expect(api).not.toContain("retains the existing unbounded path and is not covered by this conflict check")
  })

  it("states that a shared step-result tier is trusted to write into the workspace", () => {
    const guide = readDoc("guides/share-a-cache-across-machines.md").replace(/\s+/g, " ")
    expect(guide).toContain("## Trust every writer of the shared tier")
    expect(guide).toContain("A shared step-result tier is trusted to write into your workspace")
    expect(guide).toContain("Only producers you trust as much as your own machines may write to the tier")
    expect(guide).toContain("read-only credentials")
    expect(guide).toContain("signed provenance")
    const admission = readDoc("concepts/cache-admission.md").replace(/\s+/g, " ")
    expect(admission).toContain("Only producers you trust as much as your own machines may write to the shared tier")
    expect(admission).toContain("../guides/share-a-cache-across-machines.md#trust-every-writer-of-the-shared-tier")
  })

  it("assembled quickstart typechecks against public Jj", () => {
    const blocks = [...readDoc("quickstart.md").matchAll(/^```ts\n([\s\S]*?)^```/gm)]
    expect(blocks.length).toBeGreaterThan(1)
    const filename = new URL("../docs/quickstart.mts", import.meta.url).pathname
    const source = blocks.map((block) => block[1]).join("\n")
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      types: ["node"]
    }
    const host = ts.createCompilerHost(options)
    const readFile = host.readFile.bind(host)
    const fileExists = host.fileExists.bind(host)
    host.readFile = (path) => path === filename ? source : readFile(path)
    host.fileExists = (path) => path === filename || fileExists(path)
    const program = ts.createProgram([filename], options, host)
    const diagnostics = ts.getPreEmitDiagnostics(program)
    expect(
      diagnostics.map((diagnostic) =>
        ts.formatDiagnosticsWithColorAndContext([diagnostic], {
          getCanonicalFileName: (path) => path,
          getCurrentDirectory: () => host.getCurrentDirectory(),
          getNewLine: () => "\n"
        })
      )
    ).toEqual([])
  })
})

describe("source documentation pointers", () => {
  const sourceDir = new URL("../src/", import.meta.url)
  const sources = readdirSync(sourceDir).filter((name) => name.endsWith(".ts"))
  const read = (name: string): string => readFileSync(new URL(name, sourceDir), "utf8")

  it("every relative docs pointer in a public module resolves to a file", () => {
    const missing: Array<string> = []
    for (const name of sources) {
      for (const match of read(name).matchAll(/`((?:\.\.\/)*(?:docs|packages|apps)\/[^`\s]+\.(?:md|mdx))`/g)) {
        const pointer = match[1]!
        const target = pointer.startsWith("docs/")
          ? new URL(`../${pointer}`, import.meta.url)
          : new URL(`../../../../../${pointer}`, import.meta.url)
        if (!existsSync(target)) missing.push(`${name}: ${pointer}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("documents the PostgreSQL isolation used by the shipped adapter", () => {
    const adapter = readFileSync(
      new URL("../../database/src/postgres/PostgresDatabase.ts", import.meta.url),
      "utf8"
    )
    const api = readDoc("api.md")
    expect(adapter).toContain("BEGIN ISOLATION LEVEL READ COMMITTED")
    expect(adapter).toContain("pg_advisory_xact_lock")
    expect(api).toContain("READ COMMITTED")
    expect(api).toContain("transaction-scoped advisory lock")
    expect(api).toContain("PostgreSQL")
    expect(api).not.toContain("must use `SERIALIZABLE`")
    expect(api).not.toContain("only `DurableWriter` backing shipped here is `node:sqlite`")
  })

  it("names the run statuses the schema admits and the real memory transaction", () => {
    const header = read("DurableEngineState.ts")
    expect(header).not.toMatch(/one `waiting` status/)
    expect(header).toContain("`suspended`")
    expect(header).toContain("`waiting_reason`")
    expect(header).not.toContain("runs the effect directly")
    const api = readDoc("api.md").replace(/\s+/g, " ")
    expect(api).not.toContain("runs the effect directly")
    expect(api).toContain("rolls back")
  })
})
