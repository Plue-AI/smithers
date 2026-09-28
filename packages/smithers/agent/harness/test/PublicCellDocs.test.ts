import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { sep } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"

const source = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8")
const comments = (name: string) => source(name).match(/\/\*\*[\s\S]*?\*\//g) ?? []

describe("public cell documentation", () => {
  it("describes ordinary call failures as resolved data throughout the public API", () => {
    for (const name of ["Sandbox", "EngineLike", "CellCalls", "FlowBinding", "Cell"]) {
      const docs = comments(name).join("\n")
      expect(docs, name).not.toMatch(/catchable|catchably|cell (?:can|may) catch|ordinary exception/)
      expect(docs, name).toContain("{ ok: false, error }")
    }
  })

  it("documents global scripts and the first intent sealing the frame", () => {
    for (const [name, title] of [["Sandbox", "What a REPL cell"], ["Cell", "Extracts the cell program"]]) {
      const docs = comments(name!).find((comment) => comment.includes(title!))!
      expect(docs).not.toMatch(/last call wins|first `return` wins|bodies of one async/)
      expect(docs).toContain("global async script")
      expect(docs).toContain("first")
      expect(docs).toContain("seals the frame")
      expect(docs).toContain("run_completed")
    }
  })
})

const handlerExample = () => {
  const docs = comments("Sandbox").find((comment) => comment.includes("Resolves one invocation"))!
  const fence = docs.match(/```ts\n([\s\S]*?) \* ```/)
  expect(fence, "Handler must include a recovery example").not.toBeNull()
  return fence![1]!.split("\n").map((line) => line.replace(/^ \* ?/, "")).join("\n").trim()
}

it("typechecks the Handler recovery fence and keeps the guide's example identical", () => {
  const example = handlerExample()
  const guide = readFileSync(new URL("../docs/guides/run-cells.md", import.meta.url), "utf8")
  expect(guide).toContain(example)
  // A sample flow's unwrapped success shape plus the bridge's failure envelope.
  const text = `
    declare const ctx: {
      call(flow: string, input: { command: string }): Promise<
        { ok?: true; stdout: string } |
        { ok: false; error: { code: string; message: string; hint: string } }
      >
    }
    ${example}
    export {}
  `
  const file = fileURLToPath(new URL("HandlerRecovery.doc.ts", import.meta.url)).split(sep).join("/")
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === file
      ? ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([file], options, host)
  expect(
    ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
  ).toEqual([])
})

it.each([
  { failures: 0, calls: 1, printed: "found" },
  { failures: 1, calls: 2, printed: "found" },
  { failures: 2, calls: 2, printed: "timeout" }
])("executes the Handler fence with $failures timed-out calls", async ({ failures, calls, printed }) => {
  const commands: Array<string> = []
  const frame = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const sandbox = yield* QuickJSSandbox.make
    const realm = yield* sandbox.openRealm!({ flows: {} })
    return yield* realm.evaluate({
      cell: Cell.source(handlerExample()),
      frame: 0,
      call: (invocation) => {
        commands.push(JSON.stringify(invocation.input))
        return Effect.succeed(
          new Cell.CallResult(
            commands.length <= failures
              ? { outcome: "failure", value: null, code: "timeout", message: "deadline" }
              : { outcome: "success", value: { stdout: "found" } }
          )
        )
      }
    })
  })))
  expect(frame.outcome).toMatchObject({ _tag: "settled", transition: { _tag: "continue" } })
  expect(frame.prints).toBe(printed)
  expect(commands).toHaveLength(calls)
  if (calls === 2) expect(commands[1]).toContain("find src")
})

it("keeps copyable guide flow declarations free of filesystem-root grants", () => {
  // A host author copies these declarations verbatim; a root-wide read grant on a
  // handler that reads no files would reach every model-written cell calling it.
  // Both the package source and the published site mirror are checked, and both
  // the `/**` and slash-less `**` spellings count as root-wide.
  const guides = ["bind-flows", "run-cells", "drive-the-loop", "workerd"]
  const roots = ["../docs/guides/", "../../../../../apps/docs/harness/src/content/docs/guides/"]
  // The workerd `fs/list` projection lists a directory, so its read grant matches its purpose.
  const allowed = /name: "fs\/list",\n\s*description: "List a directory\.",\n\s*capabilities: \["fs:read:\*\*"\]/
  for (const root of roots) {
    for (const guide of guides) {
      const where = `${root}${guide}.md`
      const text = readFileSync(new URL(where, import.meta.url), "utf8").replace(allowed, "")
      expect(text, where).not.toMatch(/"fs:(?:read|write):\/?\*\*"/)
      expect(text, where).not.toMatch(/(?:reads|writes): \[[^\]]*"\/?\*\*"/)
    }
    const bind = readFileSync(new URL(`${root}bind-flows.md`, import.meta.url), "utf8")
    const echo = bind.match(/const echo = FlowBinding\.make\(\{[\s\S]*?\n\}\)/)![0]
    expect(echo, root).toContain("capabilities: [],")
    expect(echo, root).toContain("effects: { reads: [], writes: []")
  }
})
