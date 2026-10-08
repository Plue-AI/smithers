/**
 * flow-load (engineering spec §11.3.1, C-J5-02) on the packaged coding host:
 * each overridable flow a repository declares at one commit is loaded with
 * the host's own loader and answered as one version, its digest and whether
 * it loaded. The oracles are literal fixture trees and the built-in digest
 * the backend serves (services/builtin_flows.json).
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { bundle } from "../coding/build.mjs"
import type { FlowVersion } from "../coding/flow-load.ts"

// Keep literal loader oracles independent of later edits to the shipped TODO.
// The composed guest/browser rehearsal separately loads today's shipped source.
const fixture = fileURLToPath(new URL("./fixtures/flow-load-todo-source.ts", import.meta.url))
// Reviewed registry execution identity of the project fixture, including its empty dependency set.
const projectDigest = "c414180d136f4911aef3137992858ad88ca983b76cf65561da28e12f56db9017"

for (const pinnedAdmission of [false, true]) {
  test(
    pinnedAdmission
      ? "flow-load execution digests enter the coding host's pinned registry"
      : "flow-load answers each overridable flow's version and whether it loaded",
    {
      timeout: 300_000,
      skip: pinnedAdmission && !process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
        ? "Set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY for native guarded registry admission"
        : false
    },
    async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), "coding-flow-load-"))
      t.after(() => rm(temporary, { recursive: true, force: true }))
      const source = await readFile(fixture, "utf8")
      const tree = async (name: string, files: Record<string, string>) => {
        const root = join(temporary, name)
        for (const [path, text] of Object.entries(files)) {
          await mkdir(join(root, path, ".."), { recursive: true })
          await writeFile(join(root, path), text)
        }
        return root
      }
      // The reviewed TODO fixture, and the same source
      // beside a system name a repository cannot take.
      const copy = await tree("copy", {
        "flows/todo/flow.ts": source,
        "flows/merge/flow.ts": `throw new Error("reserved module evaluated")\n${
          source.replace("Flow.make(\"todo\",", "Flow.make(\"merge\",")
        }`,
        "src/index.ts": "export const unrelated = 1\n"
      })
      // The scripted [FLOWEDIT] change: the composition plus a changelog step.
      const edited = await tree("edited", {
        "flows/todo/flow.ts": source.replace(
          "Request.call(input)",
          "Request.call({ ...input, prompt: `${input.prompt}\\n\\n[CHANGELOG] Add one line for this change to CHANGELOG.md.` })"
        )
      })
      // A syntax error on one line of the composition.
      const broken = await tree("broken", {
        "flows/todo/flow.ts": source.replace("Request.call(input)", "Request.call(input")
      })
      const undiscoverable = await tree("undiscoverable", {
        "flows/todo/flow.ts": source.replace("description: \"Route, plan, implement and deliver one TODO.\",", ""),
        "flows/merge/flow.ts": "export default {}\n"
      })
      const rejectedAgain = await tree("undiscoverable-lock", {
        "flows/todo/flow.ts": source.replace("description: \"Route, plan, implement and deliver one TODO.\",", ""),
        "pnpm-lock.yaml": "lockfileVersion: 9\n"
      })
      // A composition that imports a helper; the helper's bytes are its version.
      const withHelper = (value: string) =>
        tree(`helper-${value}`, {
          "flows/todo/flow.ts": `import { label } from "./label.ts"\n${source}\nvoid label\n`,
          "flows/todo/label.ts": `export const label = ${JSON.stringify(value)}\n`
        })
      const [helperA, helperB] = [await withHelper("a"), await withHelper("b")]
      const outsideA = await tree("outside-a", {
        "flows/todo/flow.ts": `import { label } from "../../lib/label.ts"\n${source}\nvoid label\n`,
        "lib/label.ts": "export const label = 'a'\n"
      })
      const outsideB = await tree("outside-b", {
        "flows/todo/flow.ts": `import { label } from "../../lib/label.ts"\n${source}\nvoid label\n`,
        "lib/label.ts": "export const label = 'b'\n"
      })
      const lockA = await tree("lock-a", {
        "flows/todo/flow.ts": source,
        "pnpm-lock.yaml": "lockfileVersion: 9\n# a\n"
      })
      const lockB = await tree("lock-b", {
        "flows/todo/flow.ts": source,
        "pnpm-lock.yaml": "lockfileVersion: 9\n# b\n"
      })
      const manager = await tree("bin", {
        "pnpm": `#!/bin/sh
case "$PWD" in
  */install-failed) exit 1 ;;
  */lock-mutated) printf changed > pnpm-lock.yaml ;;
  */other-lock-mutated) printf changed > package-lock.json ;;
esac
printf '%s' "$*" > installed
`
      })
      await (await import("node:fs/promises")).chmod(join(manager, "pnpm"), 0o700)
      const importCanary = (name: string) =>
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${
          JSON.stringify(join(temporary, "import-" + name))
        }, "evaluated")\n${source}`
      const canaryLoaded = await tree("canary-loaded", {
        "flows/todo/flow.ts": importCanary("loaded"),
        "pnpm-lock.yaml": "lockfileVersion: 9\n"
      })
      const installFailed = await tree("install-failed", {
        "flows/todo/flow.ts": importCanary("failed"),
        "pnpm-lock.yaml": "lockfileVersion: 9\n"
      })
      const lockMutated = await tree("lock-mutated", {
        "flows/todo/flow.ts": importCanary("mutated"),
        "pnpm-lock.yaml": "lockfileVersion: 9\n"
      })
      const otherLockMutated = await tree("other-lock-mutated", {
        "flows/todo/flow.ts": source,
        "pnpm-lock.yaml": "lockfileVersion: 9\n",
        "package-lock.json": "{}\n"
      })
      const semantic = await tree("semantic", {
        "flows/todo/flow.ts": source.replace("Request.call(input)", "Request.call({ ...input, prompt: 123 })")
      })
      const helperTypeError = await tree("helper-type-error", {
        "flows/todo/flow.ts": `import { label } from "../../lib/label.ts"\n${source}\nvoid label\n`,
        "lib/label.ts": "export const label: string = 123\n"
      })
      const semanticCanary = await tree("semantic-canary", {
        "flows/todo/flow.ts": importCanary("semantic").replace(
          "Request.call(input)",
          "Request.call({ ...input, prompt: 123 })"
        ),
        "flows/healthy/flow.ts": source.replace("Flow.make(\"todo\",", "Flow.make(\"healthy\","),
        "node_modules/@smthrs/coding/package.json": JSON.stringify({ name: "@smthrs/coding", types: "index.d.ts" }),
        "node_modules/@smthrs/coding/index.d.ts":
          "export const Request: any; export const TodoDelivery: any; export const RequestInput: any; export const VibeDelivered: any;\n",
        // A repository cannot disable the install's semantic gate.
        "tsconfig.json": JSON.stringify({ compilerOptions: { noCheck: true, strict: false } })
      })
      const none = await tree("none", { "README.md": "No flows here.\n" })
      const prompted = await tree("prompted", {
        "flows/prompted/flow.ts": `import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
export default Flow.make("prompted", {
  description: "Teach from a prompt.", capabilities: [],
  payload: { text: Schema.String }, success: Schema.String,
  prompt: ({ text }) => { throw new Error("prompt rendered during load: " + text) }
})
`
      })

      const output = join(temporary, "host.mjs")
      await bundle(fileURLToPath(new URL("./fixtures/coding-host-flow-load-entry.ts", import.meta.url)), output)
      const flags = process.versions.bun ? [] : ["--experimental-strip-types"]
      const lines = execFileSync(process.execPath, [
        ...flags,
        output,
        copy,
        edited,
        broken,
        helperA,
        helperB,
        none,
        lockA,
        lockB,
        outsideA,
        outsideB,
        installFailed,
        lockMutated,
        otherLockMutated,
        canaryLoaded,
        undiscoverable,
        rejectedAgain,
        semantic,
        helperTypeError,
        semanticCanary,
        prompted
      ], {
        env: {
          ...process.env,
          CODING_TEST_MANAGER_PATH: manager + ":/usr/bin:/bin",
          CODING_TEST_PIN_ADMISSION: pinnedAdmission ? "1" : "0"
        },
        encoding: "utf8",
        timeout: 240_000,
        stdio: ["ignore", "pipe", "pipe"]
      }).split("\n").filter((line) => line.startsWith("versions ")).map((line) => JSON.parse(line.slice(9)))
      const [
        atCopy,
        atEdited,
        atBroken,
        atHelperA,
        atHelperB,
        atNone,
        atLockA,
        atLockB,
        atOutsideA,
        atOutsideB,
        atInstallFailed,
        atLockMutated,
        atOtherLockMutated,
        atCanaryLoaded,
        atUndiscoverable,
        atRejectedAgain,
        atSemantic,
        atHelperTypeError,
        atSemanticCanary,
        atPrompted
      ] = lines

      assert.equal(atPrompted[0].status, "loaded", atPrompted[0].error)
      assert.deepEqual(atPrompted[0].inspection.diagnostics, [])
      assert.match(atPrompted[0].inspection.prompt, /prompt rendered during load/)
      assert.deepEqual(atPrompted[0].steps, [{ id: "root.flow", label: "prompted/prompt" }])

      // Project provenance and its dependency set pin the reviewed source fixture.
      assert.equal(atCopy[0].name, "merge")
      assert.equal(atCopy[0].status, "failed")
      assert.match(atCopy[0].error, /reserved_name/)
      assert.deepEqual(
        atCopy.slice(1).map(({ name, path, digest, status }: FlowVersion) => ({ name, path, digest, status })),
        [{
          name: "todo",
          path: "flows/todo/flow.ts",
          digest: projectDigest,
          status: "loaded"
        }]
      )
      assert.deepEqual(atCopy[1].steps, [
        { id: "root.flow.andThen.andThen.flow.andThen", label: "coding/RequestFeedback" },
        { id: "root.flow.andThen.andThen.flow.then.andThen.andThen.andThen.andThen", label: "coding/prepare-stack-base" },
        { id: "root.flow.andThen.andThen.flow.then.andThen.andThen.andThen.then", label: "coding/create-stack-base" },
        { id: "root.flow.andThen.andThen.flow.then.andThen.andThen.then.then", label: "coding/install-dependency-pages" },
        { id: "root.flow.andThen.andThen.flow.then.andThen.then", label: "factory/Todo" },
        { id: "root.flow.andThen.andThen.flow.then.then.protected.map.all.result.andThen.andThen", label: "coding/PrepareRequest" },
        { id: "root.flow.andThen.andThen.flow.then.then.protected.map.all.result.andThen.then", label: "coding/admit-retained-source" },
        { id: "root.flow.andThen.andThen.flow.then.then.protected.map.all.result.then", label: "coding/CoordinateRequest" },
        { id: "root.flow.andThen.andThen.flow.then.then.failure", label: "factory/stamp-route" },
        { id: "root.flow.andThen.then", label: "coding/todo-delivery" },
        { id: "root.flow.then.flow.andThen.andThen", label: "coding/AdmitVibe" },
        { id: "root.flow.then.flow.andThen.then", label: "coding/CleanVibeHistory" },
        { id: "root.flow.then.flow.then", label: "coding/LandVibe" }
      ])
      assert.deepEqual(atCopy[1].inspection?.diagnostics, [])
      assert.ok(atCopy[1].inspection!.edges.length > 0)
      // Input-dependent prompt construction is still a runnable declaration;
      // symbolic inspection refuses it rather than rendering invented input.
      assert.equal(atEdited[0].inspection?.diagnostics[0]?.code, "declaration_requires_input")
      assert.deepEqual(atEdited[0].steps, [{ id: "root", label: "todo" }])
      // The edit loads as a new version.
      assert.equal(atEdited.length, 1)
      assert.equal(atEdited[0].status, "loaded")
      assert.match(atEdited[0].digest, /^[0-9a-f]{64}$/)
      assert.notEqual(atEdited[0].digest, projectDigest)
      // A broken composition is a failed version whose error names the file and line.
      assert.equal(atBroken.length, 1)
      assert.equal(atBroken[0].status, "failed")
      assert.notEqual(atBroken[0].digest, projectDigest)
      const line = source.split("\n").findIndex((text) => text.includes("Request.call(input)")) + 1
      assert.ok(line > 0)
      assert.match(atBroken[0].error, /^flows\/todo\/flow\.ts:\d+: /)
      assert.ok(Number(atBroken[0].error.match(/^flows\/todo\/flow\.ts:(\d+)/)![1]) >= line, atBroken[0].error)
      // A changed helper the composition imports is a new version; both load.
      assert.equal(atHelperA[0].status, "loaded", atHelperA[0].error)
      assert.equal(atHelperB[0].status, "loaded", atHelperB[0].error)
      assert.notEqual(atHelperA[0].digest, atHelperB[0].digest)
      assert.deepEqual(atHelperA[0].dependencies, ["flows/todo/label.ts"])
      assert.notEqual(atHelperA[0].digest, projectDigest)
      // A repository without flows/ declares none.
      assert.deepEqual(atNone, [])
      assert.equal(atLockA[0].status, "loaded")
      assert.equal(atLockB[0].status, "loaded")
      assert.notEqual(atLockA[0].digest, projectDigest)
      assert.notEqual(atLockA[0].digest, atLockB[0].digest)
      assert.equal(atOutsideA[0].status, "loaded", atOutsideA[0].error)
      assert.equal(atOutsideB[0].status, "loaded", atOutsideB[0].error)
      assert.deepEqual(atOutsideA[0].dependencies, ["lib/label.ts"])
      assert.notEqual(atOutsideA[0].digest, atOutsideB[0].digest)
      assert.equal(await readFile(join(lockA, "installed"), "utf8"), "install --frozen-lockfile")
      assert.equal(await readFile(join(lockB, "installed"), "utf8"), "install --frozen-lockfile")
      assert.equal(atInstallFailed[0].status, "failed")
      assert.match(atInstallFailed[0].error, /Pinned flow dependencies could not be resolved/)
      assert.doesNotMatch(atInstallFailed[0].error, /repository evaluated/)
      assert.equal(atLockMutated[0].status, "failed")
      assert.match(atLockMutated[0].error, /installation changed its lockfile/)
      assert.equal(atOtherLockMutated[0].status, "failed")
      assert.match(atOtherLockMutated[0].error, /installation changed its lockfiles/)
      await assert.rejects(readFile(join(temporary, "import-failed")), { code: "ENOENT" })
      await assert.rejects(readFile(join(temporary, "import-mutated")), { code: "ENOENT" })
      assert.equal(atCanaryLoaded[0].status, "loaded", atCanaryLoaded[0].error)
      assert.equal(await readFile(join(temporary, "import-loaded"), "utf8"), "evaluated")
      // Discovery refusal preserves the old Active version instead of removing it.
      assert.equal(atUndiscoverable.length, 2)
      assert.equal(atUndiscoverable.shift().error, "flows/merge/flow.ts: reserved_name")
      assert.equal(atUndiscoverable[0].name, "todo")
      assert.equal(atUndiscoverable[0].path, "flows/todo/flow.ts")
      assert.equal(atUndiscoverable[0].status, "failed")
      assert.match(atUndiscoverable[0].error, /flows\/todo\/flow\.ts: Module flows require a literal description/)
      assert.match(atUndiscoverable[0].digest, /^[0-9a-f]{64}$/)
      assert.equal(atRejectedAgain[0].status, "failed")
      assert.notEqual(atRejectedAgain[0].digest, atUndiscoverable[0].digest)
      assert.equal(atSemantic[0].status, "failed")
      assert.match(atSemantic[0].error, /flows\/todo\/flow\.ts:\d+: .*number.*string/)
      assert.equal(atHelperTypeError[0].status, "failed")
      assert.match(atHelperTypeError[0].error, /lib\/label\.ts:1: .*number.*string/)
      assert.equal(atSemanticCanary.find((version: FlowVersion) => version.name === "healthy").status, "loaded")
      assert.equal(atSemanticCanary.find((version: FlowVersion) => version.name === "todo").status, "failed")
      assert.match(
        atSemanticCanary.find((version: FlowVersion) => version.name === "todo").error,
        /flows\/todo\/flow\.ts:\d+: .*number.*string/
      )
      await assert.rejects(readFile(join(temporary, "import-semantic")), { code: "ENOENT" })
      const incomplete = await tree("incomplete", { "flows/flow.ts": source })
      // A partial scan cannot authorize removal of previously loaded entries.
      assert.throws(() =>
        execFileSync(process.execPath, [...flags, output, incomplete], {
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"]
        }), /root|name/i)
    }
  )
}
