/** Component provenance coverage; source exports still need real microVM qualification. */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema } from "effect"
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
