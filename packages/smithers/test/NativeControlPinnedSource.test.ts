/** Component provenance coverage; source exports still need real microVM qualification. */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import * as NativeControl from "../src/internal/NativeControl.ts"
import { platform } from "../src/internal/NodeControlHost.ts"
import * as SourceRevision from "../src/internal/SourceRevision.ts"

const NodeControl = NativeControl.make(platform)

const source = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("pinned", { description: "Pinned flow", payload: {}, success: Schema.String,
  body: () => Node.succeed("approved") })`
const flow = Flow.make("pinned", {
  description: "Pinned flow",
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("approved")
})

test("native host records the verified catalog source independently of the moved coding checkout", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "smithers-native-pinned-"))
  const pinned = join(temporary, "pinned"), branch = join(temporary, "branch")
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", [
      "-c",
      "user.email=test@example.test",
      "-c",
      "user.name=Test",
      "-c",
      "commit.gpgsign=false",
      ...args
    ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  try {
    await mkdir(join(pinned, "flows", "pinned"), { recursive: true })
    await writeFile(join(pinned, ".gitignore"), ".flows/\n")
    await writeFile(join(pinned, "flows", "pinned", "flow.ts"), source)
    git(pinned, "init", "--quiet")
    git(pinned, "add", "-A")
    git(pinned, "commit", "--quiet", "-m", "pinned source")
    const revision = git(pinned, "rev-parse", "HEAD")
    git(temporary, "clone", "--quiet", pinned, branch)
    await writeFile(join(branch, "flows", "pinned", "flow.ts"), "throw 'BRANCH_IMPORT_CANARY'")
    await writeFile(join(branch, "pnpm-lock.yaml"), "edited branch lockfile")
    git(branch, "add", "-A")
    git(branch, "commit", "--quiet", "-m", "branch moved")
    expect(git(branch, "rev-parse", "HEAD")).not.toBe(revision)
    const registry = NodeControl.layerRegistry(pinned)
    const modules = Executable.layer({
      delegates: [],
      load: (_file, verified) => {
        expect(new TextDecoder().decode(verified.bytes)).toBe(source)
        return Effect.succeed({ default: flow })
      }
    }).pipe(Layer.provide(platform.host), Layer.orDie)
    const plan = (catalogRevision?: () => Effect.Effect<string | undefined>) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          return yield* control.plan({ flowId: "pinned", input: {} })
        }).pipe(
          Effect.provide(NodeControl.layerHost(
            {
              root: branch,
              stateRoot: join(temporary, catalogRevision === undefined ? "refused-state" : "state"),
              evaluator: ScriptedJudge.layer,
              expectedSourceRevision: revision,
              catalogRevision
            },
            modules,
            registry
          )),
          Effect.scoped
        )
      )
    await expect(plan()).rejects.toThrow("Flow host source revision does not match its authorized workspace binding")
    const card = await plan(() => SourceRevision.read(pinned))
    expect(card.graph?.sourceRevision).toBe(revision)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}, 60_000)

// Both roots are composed in one memo map, as the immutable registry and the
// executing coding workspace are in the real host. Neither may borrow the
// other's filesystem instance, even though they use the same service tag.
class SourceFiles extends Context.Service<SourceFiles, FileSystem.FileSystem>()("test/SourceFiles") {}
class WorkFiles extends Context.Service<WorkFiles, FileSystem.FileSystem>()("test/WorkFiles") {}
for (const sourceFirst of [true, false]) {
  test(`pinned source and coding filesystem retain separate roots (source first: ${sourceFirst})`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), "smithers-two-roots-"))
    const source = join(temporary, "source"), workspace = join(temporary, "workspace")
    try {
      await mkdir(source)
      await mkdir(workspace)
      await writeFile(join(source, "identity.txt"), "pinned")
      await writeFile(join(workspace, "identity.txt"), "working")
      const sourceLayer = Layer.effect(SourceFiles)(FileSystem.FileSystem).pipe(
        Layer.provide(NodeControl.layerGuardedPlatform(source))
      )
      const workLayer = Layer.effect(WorkFiles)(FileSystem.FileSystem).pipe(
        Layer.provide(NodeControl.layerGuardedPlatform(workspace))
      )
      await Effect.runPromise(
        Effect.gen(function*() {
          const pinned = yield* SourceFiles, working = yield* WorkFiles
          expect(yield* pinned.readFileString(join(source, "identity.txt"))).toBe("pinned")
          expect(yield* working.readFileString(join(workspace, "identity.txt"))).toBe("working")
          expect((yield* Effect.result(pinned.readFileString(join(workspace, "identity.txt"))))._tag).toBe("Failure")
          expect((yield* Effect.result(working.readFileString(join(source, "identity.txt"))))._tag).toBe("Failure")
        }).pipe(
          Effect.provide(sourceFirst ? Layer.merge(sourceLayer, workLayer) : Layer.merge(workLayer, sourceLayer)),
          Effect.scoped
        )
      )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 60_000)
}
