import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Logger } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import * as KubernetesSandbox from "../src/KubernetesSandbox/index.ts"
import { rawPlatform } from "./helpers/containedPlatform.ts"

const root = mkdtempSync(join(tmpdir(), "smthrs-removal-cli-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const spawner = Effect.runSync(ChildProcessSpawner.pipe(Effect.provide(rawPlatform)))

const fixture = (kind: "container" | "pod", refused: boolean) => {
  const directory = mkdtempSync(join(root, `${kind}-`))
  const resource = join(directory, "resource")
  const calls = join(directory, "calls")
  const program = join(directory, "cli")
  const pids = join(directory, "pids")
  writeFileSync(
    program,
    `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
const verb = args[0];
if (verb === "create" || verb === "run") fs.writeFileSync(${JSON.stringify(resource)}, "owned");
if (verb === "exec") {
  const shell = args.indexOf("/bin/sh");
  // The guest's fixed pid directory lives under this fixture, never the host's
  // shared one: acquisition wipes it, which would end live local sessions.
  const guest = args.slice(shell + 1).map((arg) => arg.replaceAll("/tmp/.smthrs-sbx", ${JSON.stringify(pids)}));
  const result = cp.spawnSync("/bin/sh", guest, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (verb === "rm" || verb === "delete") {
  if (${refused}) { console.error("owned remove refused: SECRET_CANARY"); process.exit(42); }
  fs.rmSync(${JSON.stringify(resource)});
}
`
  )
  chmodSync(program, 0o755)
  return { program, resource, calls }
}

describe("sandbox removal through CLI", () => {
  for (const kind of ["container", "pod"] as const) {
    for (const refused of [false, true]) {
      it.effect(
        `${kind} ${refused ? "warns when removal exits nonzero" : "removes without warning"}`,
        () =>
          Effect.gen(function*() {
            const cli = fixture(kind, refused)
            const warnings: Array<string> = []
            const provider = kind === "container"
              ? ContainerSandbox.make({ spawner, image: "fixture", program: cli.program, workdir: root })
              : KubernetesSandbox.make({ spawner, image: "fixture", program: cli.program, workdir: root })
            yield* Effect.scoped(Effect.flatMap(provider.acquire("removal"), () => Effect.void)).pipe(
              Effect.provide(Logger.layer([Logger.make((entry) => {
                if (entry.logLevel === "Warn") warnings.push(JSON.stringify(entry))
              })]))
            )
            const calls = readFileSync(cli.calls, "utf8")
            expect(calls).toContain(kind === "container" ? "rm --force" : "delete pod/")
            expect(existsSync(cli.resource)).toBe(refused)
            if (refused) {
              expect(warnings).toHaveLength(1)
              expect(warnings[0]).toContain("\"exitCode\":42")
              expect(warnings[0]).toContain("smthrs-sbx-")
              expect(warnings[0]).not.toContain("SECRET_CANARY")
            } else {
              expect(warnings).toEqual([])
            }
          }),
        30_000
      )
    }
    it.effect(`${kind} warns when the removal CLI cannot start`, () =>
      Effect.gen(function*() {
        const cli = fixture(kind, false)
        const warnings: Array<string> = []
        const provider = kind === "container"
          ? ContainerSandbox.make({ spawner, image: "fixture", program: cli.program, workdir: root })
          : KubernetesSandbox.make({ spawner, image: "fixture", program: cli.program, workdir: root })
        yield* Effect.scoped(
          Effect.flatMap(provider.acquire("missing-cli"), () => Effect.sync(() => rmSync(cli.program)))
        ).pipe(
          Effect.provide(Logger.layer([Logger.make((entry) => {
            if (entry.logLevel === "Warn") warnings.push(JSON.stringify(entry))
          })]))
        )
        expect(existsSync(cli.resource)).toBe(true)
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("smthrs-sbx-")
        expect(warnings[0]).not.toContain("SECRET_CANARY")
      }), 30_000)
  }
})
