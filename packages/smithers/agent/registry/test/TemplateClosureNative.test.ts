/** Closure identity and pre-import refusal through Node, outside Vitest's module runner. */
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const driver = fileURLToPath(new URL("./fixtures/native/template-closure.ts", import.meta.url))
const template = (expression: string) => "`${" + expression + "}`"
const nested = (expression: string, depth: number) => {
  for (let index = 0; index < depth; index++) expression = template(expression)
  return expression
}
const entry = (expression: string, prefix = "") =>
  `import { Annotations } from "@smthrs/core"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
${prefix}
const priority = Number(${expression})
export default Flow.make("entry", {
  description: "A measured template closure", capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: {}, success: Schema.Number, body: () => Node.succeed(priority)
}).annotate(Annotations.Priority, priority)
`
interface Result {
  priority?: number
  imports?: ReadonlyArray<string>
  stale?: string
  before?: string
  after?: string
  leftovers?: ReadonlyArray<string>
  code?: string
  message?: string
}
const run = async (source: string): Promise<Result> => {
  const root = await mkdtemp(join(modulesRoot, ".native-template-"))
  try {
    await mkdir(join(root, "flows/entry"), { recursive: true })
    await writeFile(join(root, "flows/entry/flow.ts"), source)
    await writeFile(join(root, "flows/entry/helper.ts"), "export const priority = 7\n")
    const output = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        [driver, root],
        { timeout: 60_000 },
        (error, stdout, stderr) => error === null ? resolve(stdout) : reject(new Error(`${error.message}\n${stderr}`))
      )
    )
    return JSON.parse(output) as Result
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
describe("template closures under real Node", () => {
  it.each([1, 2, 3])("measures depth %i and refuses runtime loading and the stale descriptor", async (depth) => {
    const result = await run(entry(nested("(await import(\"./helper.ts\")).priority", depth)))
    expect(result.code).toBe("body_unavailable")
    expect(result.message).toContain("runtime module cache")
    expect(result.priority).toBeUndefined()
    expect(result.imports).toEqual(["helper.ts"])
    expect(result.stale).toBe("body_unavailable")
    expect(result.after).not.toBe(result.before)
    expect(result.leftovers).toEqual([])
  }, 90_000)
  it("retains ordinary static closure identity and refusal", async () => {
    const result = await run(entry("helper", "import { priority as helper } from \"./helper.ts\""))
    expect(result.priority).toBe(7)
    expect(result.imports).toEqual(["helper.ts"])
    expect(result.stale).toBe("body_unavailable")
    expect(result.after).not.toBe(result.before)
  }, 90_000)
  it.each([
    template("(await import(\"./\" + \"helper.ts\")).priority")
  ])("refuses unpinnable substitutions before loading: %s", async (expression) => {
    const result = await run(entry(expression))
    expect(result.code).toBe("body_unavailable")
    expect(result.message).toContain("cannot pin")
    expect(result.priority).toBeUndefined()
  }, 90_000)
})
