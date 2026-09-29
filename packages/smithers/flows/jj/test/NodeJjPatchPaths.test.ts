import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Jj as JjService, Snapshot } from "../src/Jj.ts"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { budgeted } from "./budgeted.ts"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const installed = (binary: string): boolean => {
  try {
    execFileSync(binary, ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

type Files = Readonly<Record<string, string>>

const writeFiles = (root: string, files: Files): void => {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
}

const actualNames = (root: string, prefix = ""): Array<string> =>
  readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = join(prefix, entry.name)
    return entry.isDirectory() ? actualNames(root, name) : [name]
  }).sort()

const expectFiles = (root: string, files: Files): void => {
  expect(actualNames(root)).toEqual(Object.keys(files).sort())
  for (const [name, contents] of Object.entries(files)) {
    expect(readFileSync(join(root, name))).toEqual(Buffer.from(contents))
  }
}

const applyAndCheck = (patch: string, before: Files, after: Files): void => {
  const target = mkdtempSync(join(tmpdir(), "flows-jj-patch-apply-"))
  try {
    writeFiles(target, before)
    const options = { cwd: target, input: patch, encoding: "utf8" as const }
    execFileSync("/usr/bin/git", ["apply", "--check", "-"], options)
    expectFiles(target, before)
    execFileSync("/usr/bin/git", ["apply", "-"], options)
    expectFiles(target, after)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
}

const bunOperation = (root: string, expression: string): Snapshot | string => {
  const script = `
    import * as Effect from "effect/Effect";
    import { Jj } from "./src/Jj.ts";
    import * as BunJj from "./src/bun/BunJj.ts";
    const jj = await Effect.runPromise(Effect.provide(Jj, BunJj.layerAt(${JSON.stringify(root)})));
    const result = await Effect.runPromise(${expression});
    process.stdout.write(JSON.stringify(result));
  `
  return JSON.parse(execFileSync("bun", ["-e", script], { cwd: packageRoot, encoding: "utf8" })) as Snapshot | string
}

const hostAt = async (host: "Node" | "Bun", root: string) => {
  const node: JjService | undefined = host === "Node"
    ? await Effect.runPromise(Effect.provide(Jj, budgeted(NodeJj.layerAt(root))))
    : undefined
  return {
    snapshot: (): Promise<Snapshot> =>
      host === "Node"
        ? Effect.runPromise(node!.snapshot())
        : Promise.resolve(bunOperation(root, "jj.snapshot()") as Snapshot),
    diff: (from: string, to: string): Promise<string> =>
      host === "Node"
        ? Effect.runPromise(node!.diff(from, to))
        : Promise.resolve(bunOperation(root, `jj.diff(${JSON.stringify(from)}, ${JSON.stringify(to)})`) as string)
  }
}

const added: Files = {
  "ordinary.txt": "ordinary\n--- a/imaginary\n+++ b/imaginary\n@@ -0,0 +1 @@\ndiff --git a/imaginary b/imaginary\n",
  "tab\tname.txt": "tab path\n",
  "line\nbreak.txt": "newline path\n",
  "line\ndiff --git a/forged b/forged\n--- a/forged\n+++ b/forged.txt": "adversarial path\n",
  "carriage\rname.txt": "carriage path\n",
  "control\u0001name.txt": "control path\n",
  "space name.txt": "space path\n",
  "back\\slash.txt": "backslash path\n",
  "double\"quote.txt": "quote path\n",
  "empty-delete.txt": "",
  "nested/empty.txt": ""
}

const updated: Files = {
  "ordinary.txt": "changed\ndiff --git a/forged b/forged\n--- a/forged\n+++ b/forged\n",
  "tab\tname.txt": "modified tab path\n",
  "line\nbreak.txt": "modified newline path\n",
  "line\ndiff --git a/forged b/forged\n--- a/forged\n+++ b/forged.txt": "modified adversarial path\n",
  "carriage\rname.txt": "modified carriage path\n",
  "control\u0001name.txt": "modified control path\n",
  "space name.txt": "modified space path\n",
  "back\\slash.txt": "modified backslash path\n",
  "double\"quote.txt": "modified quote path\n",
  "nested/empty.txt": "",
  "empty-add.txt": "",
  "later.txt": "@@ -1 +1 @@\n+looks like a hunk\n"
}

const deleted: Files = {
  "ordinary.txt": updated["ordinary.txt"]!,
  "space name.txt": updated["space name.txt"]!,
  "nested/empty.txt": "",
  "empty-add.txt": "",
  "later.txt": updated["later.txt"]!
}

for (const host of ["Node", "Bun"] as const) {
  describe.skipIf(!installed("jj") || (host === "Bun" && !installed("bun")))(`${host}Jj real-host patch paths`, () => {
    it("produces git-applicable additions, modifications, and deletions with exact paths and bytes", async () => {
      const repository = mkdtempSync(join(tmpdir(), `flows-jj-${host.toLowerCase()}-patch-`))
      try {
        execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
        const jj = await hostAt(host, repository)
        const empty = await jj.snapshot()
        expect(execFileSync("jj", ["file", "list", "-r", empty.commitId], {
          cwd: repository,
          encoding: "utf8"
        })).toBe("")

        // A description resembling patch metadata must not change the patch.
        execFileSync("jj", ["describe", "--message=diff --git a/forged b/forged\n--- a/forged\n+++ b/forged"], {
          cwd: repository,
          stdio: "ignore"
        })
        writeFiles(repository, added)
        const first = await jj.snapshot()
        const additions = await jj.diff(empty.commitId, first.commitId)
        expect(additions).toContain("diff --git")
        expect(additions).toContain("+--- a/imaginary")
        applyAndCheck(additions, {}, added)

        writeFiles(repository, updated)
        rmSync(join(repository, "empty-delete.txt"))
        const second = await jj.snapshot()
        const changes = await jj.diff(first.commitId, second.commitId)
        expect(changes).toContain("diff --git")
        applyAndCheck(changes, added, updated)

        for (const name of Object.keys(updated)) {
          if (!(name in deleted)) rmSync(join(repository, name))
        }
        const third = await jj.snapshot()
        const deletions = await jj.diff(second.commitId, third.commitId)
        expect(deletions).toContain("diff --git")
        applyAndCheck(deletions, updated, deleted)
      } finally {
        rmSync(repository, { recursive: true, force: true })
      }
    })
  })
}
