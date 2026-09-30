/** Actual Node/Bun admission refuses host-cache operations before evaluating flow code. */
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const driver = fileURLToPath(new URL("./fixtures/native/identity-contract.ts", import.meta.url))
const countedHelper =
  "globalThis.__identityHelperEvaluations = (globalThis.__identityHelperEvaluations ?? 0) + 1; export const priority = 7\n"
const entry = (prefix: string) =>
  `import { Annotations } from "@smthrs/core"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
${prefix}
globalThis.__identityEntryEvaluations = (globalThis.__identityEntryEvaluations ?? 0) + 1
export default Flow.make("entry", {
  description: "Measured identity admission", capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: {}, success: Schema.Number, body: () => Node.succeed(priority)
}).annotate(Annotations.Priority, priority)
`
interface Loaded {
  readonly priority?: number
  readonly code?: string
  readonly message?: string
}
interface Result {
  readonly before: Loaded
  readonly after: Loaded
  readonly stale: Loaded
  readonly previousDigest: string
  readonly freshDigest: string
  readonly helperEvaluations: number
  readonly entryEvaluations: number
  readonly leftovers: ReadonlyArray<string>
}
const run = async (runtime: string, files: Readonly<Record<string, string>>, edited = "flows/entry/helper.ts") => {
  const root = await mkdtemp(join(modulesRoot, ".native-identity-"))
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true })
      await writeFile(join(root, path), content)
    }
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        runtime,
        [driver, root, join(root, edited)],
        { timeout: 60_000 },
        (error, output, stderr) => error === null ? resolve(output) : reject(new Error(`${error.message}\n${stderr}`))
      )
    )
    return JSON.parse(stdout) as Result
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
for (const [name, runtime] of [["Node", process.execPath], ["Bun", "bun"]]) {
  describe(`measured closure identity under actual ${name}`, () => {
    it.each(
      [
        ["direct", entry("import { priority } from \"./helper.ts\""), {}],
        ["transitive cycle", entry("import { priority } from \"./middle.ts\""), {
          "flows/entry/middle.ts":
            "import { priority } from \"./helper.ts\"; import \"./cycle.ts\"; export { priority }",
          "flows/entry/cycle.ts": "import { priority } from \"./middle.ts\"; export const echo = () => priority"
        }],
        ["single imports mapping", entry("import { priority } from \"#helper\""), {
          "package.json": JSON.stringify({ type: "module", imports: { "#helper": "./flows/entry/helper.ts" } })
        }]
      ] as const
    )("refreshes supported static %s with old-descriptor refusal", async (_label, source, extra) => {
      const result = await run(runtime!, {
        "flows/entry/flow.ts": source,
        "flows/entry/helper.ts": countedHelper,
        ...extra
      })
      expect(result.before.priority, JSON.stringify(result)).toBe(7)
      expect(result.after.priority).toBe(9)
      expect(result.stale.code).toBe("body_unavailable")
      expect(result.freshDigest).not.toBe(result.previousDigest)
      expect(result.helperEvaluations).toBe(2)
      expect(result.entryEvaluations).toBe(2)
      expect(result.leftovers).toEqual([])
    }, 90_000)
    it.each(
      [
        ["immediate dynamic", entry("const priority = (await import(\"./helper.ts\")).priority"), {}],
        ["transitive dynamic", entry("import { priority } from \"./middle.ts\""), {
          "flows/entry/middle.ts": "export const priority = (await import(\"./helper.ts\")).priority"
        }],
        ["deferred dynamic", entry("const priority = 7; export const late = () => import(\"./helper.ts\")"), {}],
        ["deferred require", entry("const priority = 7; export const late = () => require(\"./helper.ts\")"), {}],
        ["mapped bare", entry("import { priority } from \"helper\""), {
          "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "./flows/entry" } })
        }],
        ["conditional imports mapping", entry("import { priority } from \"#helper\""), {
          "package.json": JSON.stringify({
            type: "module",
            imports: { "#helper": { node: "./flows/entry/helper.ts", default: "./flows/entry/other.ts" } }
          }),
          "flows/entry/other.ts": "export const priority = 11"
        }]
      ] as const
    )("refuses unsupported %s before evaluation, including a fresh descriptor", async (_label, source, extra) => {
      const result = await run(runtime!, {
        "flows/entry/flow.ts": source,
        "flows/entry/helper.ts": countedHelper,
        ...extra
      })
      for (const loaded of [result.before, result.after]) {
        expect(loaded.code).toBe("body_unavailable")
        expect(loaded.priority).toBeUndefined()
        expect(loaded.message).toContain("cannot pin")
      }
      expect(result.stale.code).toBe("body_unavailable")
      expect(result.stale.priority).toBeUndefined()
      expect(result.stale.message).toContain("changed")
      expect(result.freshDigest).not.toBe(result.previousDigest)
      expect(result.helperEvaluations).toBe(0)
      expect(result.entryEvaluations).toBe(0)
      expect(result.leftovers).toEqual([])
    }, 90_000)
  })
}
