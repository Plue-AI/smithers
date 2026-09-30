import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll } from "vitest"
import * as CommandSandbox from "../src/CommandSandbox/index.ts"
import { pidDirectory } from "../src/internal/pidDirectory.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import { platform } from "./helpers/containedPlatform.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-heartbeat-local-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("CommandSandbox local heartbeat", () => {
  for (const [name, services] of [["NodeServices", NodeServices.layer], ["contained platform", platform]] as const) {
    it.effect(
      `keeps a real local command alive through repeated boot probes with ${name}`,
      () =>
        Effect.gen(function*() {
          const local = yield* ChildProcessSpawner
          let launches = 0
          // Count transports while retaining the real process, stdin, and supervision.
          const spawner = makeSpawner((command) => {
            launches++
            return local.spawn(command)
          })
          const session = yield* CommandSandbox.make({
            spawner,
            prefix: [],
            heartbeat: "250 millis",
            workdir: root
          }).acquire(`${basename(root)}-${name}`)
          const child = yield* session.spawn("printf 'ready|'; sleep 20; printf done", {})
          const before = launches
          expect(yield* child.exitCode).toBe(0)
          expect(yield* Stream.mkString(Stream.decodeText(child.stdout))).toBe("ready|done")
          // No file/ping operations run in this interval: these are heartbeat probes.
          expect(launches - before).toBeGreaterThanOrEqual(3)
        }).pipe(Effect.scoped, Effect.provide(services)),
      45_000
    )
  }

  it.effect(
    "does not treat completed probes with slow scope cleanup as a silent machine",
    () =>
      Effect.gen(function*() {
        const local = yield* ChildProcessSpawner
        let launches = 0
        const id = `${basename(root)}-slow-cleanup`
        const record = join(pidDirectory, sessionSlug(id), "0.pid")
        let startingGuest = false
        // Delay scope cleanup only: probe execution and all process supervision
        // remain real. This reproduces cleanup exceeding the response deadline.
        const spawner = makeSpawner((command) => {
          launches++
          const awaitRecord = startingGuest
          startingGuest = false
          return local.spawn(command).pipe(
            // Isolate cleanup from startup: the real shell must finish its boot
            // and pid records before this adapter returns the guest handle.
            Effect.tap(() =>
              awaitRecord
                ? Effect.promise(async () => {
                  const deadline = Date.now() + 5000
                  while (
                    !existsSync(`${record}.boot`) || !existsSync(record) || readFileSync(record, "utf8").trim() === ""
                  ) {
                    if (Date.now() >= deadline) {
                      throw new Error(`guest did not write its boot and pid records: ${record}`)
                    }
                    await new Promise((resolve) => setTimeout(resolve, 10))
                  }
                })
                : Effect.void
            ),
            Effect.tap(() =>
              Effect.addFinalizer(() => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 300))))
            )
          )
        })
        const session = yield* CommandSandbox.make({
          spawner,
          prefix: [],
          heartbeat: "100 millis",
          workdir: root
        }).acquire(id)
        startingGuest = true
        const child = yield* session.spawn("printf 'ready|'; sleep 2; printf done", {})
        const before = launches
        expect(yield* child.exitCode).toBe(0)
        expect(yield* Stream.mkString(Stream.decodeText(child.stdout))).toBe("ready|done")
        expect(launches - before).toBeGreaterThanOrEqual(2)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    15_000
  )
})
