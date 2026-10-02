/** Host-local durable job handles and collection receipts; values contain no credentials. */
import { Effect, Layer, Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname, join, resolve } from "node:path"

const receiptName = (key: string) => `${createHash("sha256").update(key).digest("hex")}.json`
const isReceipt = (name: string) => /^[a-f0-9]{64}\.json$/.test(name)
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException).code === "ENOENT"

/** Fsync both file contents and the directory entry that publishes or removes them. */
const syncDirectory = async (directory: string) => {
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export const make = (directory: string) =>
  Effect.gen(function*() {
    const operation = <A>(method: string, key: string | undefined, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          new KeyValueStore.KeyValueStoreError({
            method,
            ...(key === undefined ? {} : { key }),
            message: `Job receipt ${method} failed`,
            cause
          })
      })
    yield* operation("initialize", undefined, async () => {
      const created = await fs.mkdir(directory, { recursive: true })
      if (created === undefined) return
      const parent = dirname(resolve(created))
      let current = resolve(directory)
      for (;;) {
        await syncDirectory(current)
        if (current === parent) break
        current = dirname(current)
      }
    })
    return KeyValueStore.makeStringOnly({
      get: (key) =>
        operation("get", key, async () => {
          try {
            return await fs.readFile(join(directory, receiptName(key)), "utf8")
          } catch (cause) {
            if (missing(cause)) return undefined
            throw cause
          }
        }),
      set: (key, value) =>
        operation("set", key, async () => {
          const temporary = join(directory, `.${receiptName(key)}.${randomUUID()}.tmp`)
          try {
            const file = await fs.open(temporary, "wx", 0o600)
            try {
              await file.writeFile(value, "utf8")
              await file.sync()
            } finally {
              await file.close()
            }
            await fs.rename(temporary, join(directory, receiptName(key)))
            await syncDirectory(directory)
          } finally {
            await fs.unlink(temporary).catch((cause: unknown) => {
              if (!missing(cause)) throw cause
            })
          }
        }).pipe(Effect.uninterruptible),
      remove: (key) =>
        operation("remove", key, async () => {
          await fs.unlink(join(directory, receiptName(key))).catch((cause: unknown) => {
            if (!missing(cause)) throw cause
          })
          await syncDirectory(directory)
        }).pipe(Effect.uninterruptible),
      clear: operation("clear", undefined, async () => {
        for (const name of await fs.readdir(directory)) {
          if (isReceipt(name)) await fs.unlink(join(directory, name))
        }
        await syncDirectory(directory)
      }).pipe(Effect.uninterruptible),
      size: operation("size", undefined, async () => (await fs.readdir(directory)).filter(isReceipt).length)
    })
  })

/** All sweep hosts in this checkout share the same receipt directory. */
export const layer = (repository: string) =>
  Layer.effect(KeyValueStore.KeyValueStore)(make(join(repository, ".flows", "issue-sweep-jobs")))

/** Rebuild account holds before admitting work on a newly started host. */
export const values = (repository: string) =>
  Effect.tryPromise({
    try: async () => {
      const directory = join(repository, ".flows", "issue-sweep-jobs")
      let names: ReadonlyArray<string>
      try {
        names = await fs.readdir(directory)
      } catch (cause) {
        if (missing(cause)) return []
        throw cause
      }
      const values: Array<string> = []
      for (const name of names.filter(isReceipt).sort()) {
        try {
          values.push(await fs.readFile(join(directory, name), "utf8"))
        } catch (cause) {
          // Another host can finish and remove a receipt after the listing.
          if (!missing(cause)) throw cause
        }
      }
      return values
    },
    catch: (cause) =>
      new KeyValueStore.KeyValueStoreError({ method: "values", message: "Job receipts could not be read", cause })
  })

export const Assignment = Schema.Struct({
  key: Schema.String,
  agent: Schema.Literals(["codex", "claude"]),
  account: Schema.String
})

/** Reestablish parked jobs' account holds before any new reservation. */
export const restoreAssignments = (
  repository: string,
  restore: (key: string, agent: "codex" | "claude", account: string) => void
) =>
  Effect.gen(function*() {
    for (const value of yield* values(repository)) {
      const assigned = Schema.decodeUnknownOption(Schema.fromJsonString(Assignment))(value)
      if (assigned._tag === "Some") restore(assigned.value.key, assigned.value.agent, assigned.value.account)
    }
  })
