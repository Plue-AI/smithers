/**
 * A registry refresh after editing only a helper loads the helper's new bytes
 * under the host's own module loader.
 *
 * The loader used to evaluate a verified copy of the entry and leave its
 * relative imports to the original helper paths, which Node's module cache
 * answered with the exports of the first load: the refreshed descriptor's
 * identity recorded the new helper while the old one ran. Vitest's module
 * runner answers `import()` itself, so these cases run real Node in a child
 * process over a project whose `node_modules` resolve.
 */
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const driver = fileURLToPath(new URL("./fixtures/native/helper-refresh.ts", import.meta.url))

interface Loaded {
  readonly priority: number
  readonly digest: string
}

const entry = `import { Annotations } from "@smthrs/core"
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
import { priority } from "./helper.ts"

export default Flow.make("entry", {
  description: "Takes its priority from a helper",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: {},
  success: Schema.Unknown,
  body: () => undefined as never
}).annotate(Annotations.Priority, priority)
`

/** Runs the driver over a fresh project whose files are `files`, editing `edited`. */
const refreshAfterEditing = async (files: Record<string, string>, edited: string) => {
  const root = await mkdtemp(join(modulesRoot, ".native-refresh-"))
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(root, "flows/entry", name, ".."), { recursive: true })
      await writeFile(join(root, "flows/entry", name), text)
    }
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        [driver, root, join(root, "flows/entry", edited)],
        { timeout: 60_000 },
        (error, out, stderr) => error === null ? resolve(out) : reject(new Error(`${error.message}\n${stderr}`))
      )
    )
    return JSON.parse(stdout) as { readonly before: Loaded; readonly after: Loaded }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("refreshing after editing only a helper, under real Node", () => {
  it("loads a direct helper's new exports", async () => {
    const { after, before } = await refreshAfterEditing({
      "flow.ts": entry,
      "helper.ts": "export const priority: number = 7\n"
    }, "helper.ts")
    expect(before.priority).toBe(7)
    expect(after.digest).not.toBe(before.digest)
    expect(after.priority).toBe(9)
  }, 90_000)

  it("loads a transitive helper's new exports through an unchanged direct one and a cycle", async () => {
    const { after, before } = await refreshAfterEditing({
      "flow.ts": entry,
      "helper.ts":
        `import { priority as deep } from "./lib/deep.ts"\nimport "./lib/cycle.ts"\nexport const priority = deep\n`,
      "lib/deep.ts": "export const priority: number = 7\n",
      "lib/cycle.ts": `import { priority } from "../helper.ts"\nexport const echo = () => priority\n`
    }, "lib/deep.ts")
    expect(before.priority).toBe(7)
    expect(after.digest).not.toBe(before.digest)
    expect(after.priority).toBe(9)
  }, 90_000)
})
