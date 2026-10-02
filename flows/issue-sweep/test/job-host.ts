// One retained job across independent host processes; no agent credentials.
import { NodeServices } from "@effect/platform-node"
import * as CloudSandbox from "@smthrs/cli/CloudSandbox"
import { Sandbox } from "@smthrs/sandbox"
import { Effect, Layer } from "effect"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { makeJob } from "../vm.ts"

const [directory, backend, mode, key] = process.argv.slice(2) as [string, string, string, string]
const handlePath = join(directory, "handle.json")
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
await Effect.runPromise(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const api = CloudSandbox.workspaceApi(process.env)
    const transport: CloudSandbox.WorkspaceApi = {
      sshPrefix: api.sshPrefix,
      request: async (...args) => {
        try {
          return await api.request(...args)
        } catch (cause) {
          const error = cause as { status?: number; code?: string; detail?: { code?: string } }
          console.error(
            JSON.stringify({ method: args[0], status: error.status, code: error.detail?.code ?? error.code })
          )
          // Creation may be admitted before its response fails. Remove only this
          // test's exact stable name; never clean up another run's workspace.
          if (args[0] === "POST" && args[1].endsWith("/workspaces")) {
            const name = (args[2] as { name: string }).name
            const listed = await api.request("GET", args[1], undefined, AbortSignal.timeout(30_000))
            for (const row of listed as Array<{ id: string; name: string }>) {
              if (row.name === name) {
                await api.request(
                  "DELETE",
                  `${args[1]}/${encodeURIComponent(row.id)}`,
                  undefined,
                  AbortSignal.timeout(30_000)
                )
              }
            }
          }
          throw cause
        }
      }
    }
    const provider = backend === "cloud"
      ? CloudSandbox.make({
        spawner,
        repository: process.env.SMITHERS_CLOUD_SANDBOX_REPOSITORY ?? "smithersai/smithers",
        api: transport,
        persistence: "sticky",
        namePrefix: "job-restart-",
        readyTimeout: "15 minutes"
      })
      : makeJob({ refresh: false, minFreeBytes: 1024 ** 3 })
    const job = Sandbox.job(provider, {
      command: "printf 'job-edit-once\\n' >> README.md; printf 'launch-once\\n'; sleep 20; printf 'finished\\n'"
    })
    if (mode === "start") {
      const handle = yield* job.start({}, key)
      yield* Effect.promise(() => writeFile(handlePath, JSON.stringify(handle)))
      emit({ status: "ready", handle })
      return yield* Effect.never
    }
    const handle = JSON.parse(yield* Effect.promise(() => readFile(handlePath, "utf8"))) as Sandbox.JobHandle
    if (mode === "cleanup") {
      yield* job.cancel(handle, key)
      emit({ status: "removed" })
      return
    }
    const same = yield* job.start({}, key)
    if (JSON.stringify(same) !== JSON.stringify(handle)) return yield* Effect.die("reattach returned another job")
    for (let attempt = 0; attempt < 180; attempt++) {
      const status = yield* job.status(handle, key)
      if (status._tag === "Lost") return yield* Effect.die("job lost after host SIGKILL")
      if (status._tag === "Exited") {
        const result = yield* job.collect(handle, key, status)
        const cached = yield* job.collect(handle, key, status)
        const removed = yield* job.status(handle, key)
        emit({ status: "completed", handle, result, cached, removed })
        return
      }
      yield* Effect.sleep("1 second")
    }
    return yield* Effect.die("job did not exit")
  }).pipe(
    Effect.provide(Layer.provideMerge(KeyValueStore.layerFileSystem(join(directory, "receipts")), NodeServices.layer))
  )
)
