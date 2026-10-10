/** Installed command audit. Repository results cannot manufacture these bytes. */
import { Effect, type FileSystem, Option, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { CommandReceipt } from "../../packages/smithers/gateway/src/RuntimeBridge.ts"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"

type Result = {
  readonly exitCode: number
  readonly stderr: { readonly text: string }
  readonly fault?: "factory" | "infra"
}
export interface CommandReceipts {
  readonly begin: (argv: readonly [string, ...Array<string>]) => Effect.Effect<
    ((result: Result) => Effect.Effect<void, unknown>) | undefined,
    unknown
  >
  readonly read: (runId: string) => Effect.Effect<CommandReceipt | undefined, unknown>
}

/** The host captures its raw filesystem before any repository action guards. */
export const commandReceipts = (fs: FileSystem.FileSystem, directory: string): CommandReceipts => {
  const file = (runId: string) => join(directory, createHash("sha256").update(runId).digest("hex") + ".json")
  const write = (receipt: CommandReceipt) =>
    Effect.gen(function*() {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
      const temporary = file(receipt.runId) + "." + randomUUID()
      yield* fs.writeFileString(temporary, JSON.stringify(receipt), { mode: 0o600 })
      yield* fs.rename(temporary, file(receipt.runId))
    })
  return {
    begin: (argv) =>
      Effect.gen(function*() {
        const owner = yield* Effect.serviceOption(ModuleOwner)
        if (Option.isNone(owner)) return undefined
        const receipt: CommandReceipt = {
          runId: owner.value.rootId,
          operationId: randomUUID(),
          status: "running",
          argv
        }
        // Invalidate the earlier exit before spawning, including failed launches.
        yield* write(receipt)
        return (result: Result) =>
          write({
            ...receipt,
            status: "completed",
            exitCode: result.exitCode,
            stderr: result.stderr.text,
            ...(result.fault === undefined ? {} : { fault: result.fault })
          })
      }),
    read: (runId) =>
      Effect.gen(function*() {
        const path = file(runId)
        if (!(yield* fs.exists(path))) return undefined
        return yield* Schema.decodeUnknownEffect(CommandReceipt)(JSON.parse(yield* fs.readFileString(path)))
      })
  }
}
