/**
 * The supervisor's memory as the native host composes it: which database it
 * lives in, how that database waits for a concurrent writer, how recall reads
 * it, which bank a run of this workspace reads and writes, and whether the
 * run may write at all.
 *
 * Kept apart from `NativeControl` so the executor registration and the tests
 * that hold it to its promises build one and the same layer.
 *
 * @since 1.0.0
 * @private
 */

import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Memory from "@smthrs/agent/Memory"
import * as Capability from "@smthrs/capability/Capability"
import type * as DurableWriter from "@smthrs/database/DurableWriter"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as Maintenance from "@smthrs/memory/Maintenance"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import type * as Recall from "@smthrs/memory/Recall"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import { Context, Effect, Layer, Option } from "effect"
import type * as Crypto from "effect/Crypto"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import * as CliError from "../CliError.ts"
import * as Environment from "../Environment.ts"

/**
 * How long a connection to a memory database waits for another writer's lock
 * before SQLite answers `SQLITE_BUSY`, in milliseconds. `SMITHERS_MEMORY_DB`
 * exists to be shared: every run of one repository opens it, from as many
 * processes as a wave runs at once, and SQLite's own default is not to wait.
 *
 * @since 1.0.0
 * @private
 */
export const busyTimeoutMs = 10_000

/**
 * What the supervisor may do with memory on this host, in `Agent.Options`
 * form.
 *
 * `banks` names the shared project bank: the memory database when `SMITHERS_MEMORY_DB`
 * names one, because an operator who points every workspace of a repository
 * at one file has said which runs share a memory; the workspace root
 * otherwise. Never one bank for every repository on the host.
 *
 * `remember` is on only when the operator opted into a memory database of
 * its own; a workspace's engine database is not a place a run's sentences
 * should accumulate unasked.
 *
 * `stance` is {@link stance}.
 *
 * @since 1.0.0
 * @private
 */
export const options = (
  environment: Environment.Source,
  workspaceRoot: string
): {
  readonly remember: boolean
  readonly banks: ReadonlyArray<string>
  readonly stance: "careful" | "paranoid"
} => {
  const database = Environment.read(environment, "SMITHERS_MEMORY_DB")
  const identity = resolve(database ?? workspaceRoot)
  return {
    remember: database !== undefined,
    banks: [`project-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`],
    stance: stance(environment)
  }
}

/**
 * The static stance a judged run is taught: `SMITHERS_SUPERVISOR_STANCE`,
 * `careful` when unset. It arms nothing. Any other value refuses host
 * composition with a `UsageError` naming the variable.
 *
 * @since 1.0.0
 * @private
 */
export const stance = (environment: Environment.Source): "careful" | "paranoid" => {
  const value = Environment.read(environment, "SMITHERS_SUPERVISOR_STANCE") ?? "careful"
  try {
    return AgentAction.supervisorStance({ SMITHERS_SUPERVISOR_STANCE: value })
  } catch {
    throw new CliError.UsageError({
      message: `SMITHERS_SUPERVISOR_STANCE must be careful or paranoid, not ${JSON.stringify(value)}`
    })
  }
}

/**
 * The database the memory store lives in: `SMITHERS_MEMORY_DB` opened with a
 * busy timeout so concurrent writers wait for each other instead of failing,
 * else the workspace `stores`. The executor and the `memory` CLI both resolve
 * the store through this, so a note one writes is the note the other lists.
 *
 * @since 1.0.0
 * @private
 */
export const memoryDatabase = (input: {
  readonly environment: Environment.Source
  readonly database: (filename: string) => Layer.Layer<DurableWriter.DurableWriter | SqlClient>
  /** The workspace's own stores, used when `SMITHERS_MEMORY_DB` names no file. */
  readonly stores?: Layer.Layer<DurableWriter.DurableWriter | SqlClient> | undefined
}): Layer.Layer<DurableWriter.DurableWriter | SqlClient> => {
  const file = Environment.read(input.environment, "SMITHERS_MEMORY_DB")
  if (file === undefined && input.stores === undefined) {
    throw new CliError.Refused({
      fault: "bug",
      code: "memory_store_missing",
      message: "Smithers has no memory store for this workspace. Not your fault."
    })
  }
  return file === undefined ? input.stores! : input.database(file).pipe(
    Layer.tap((context) =>
      Context.get(context, SqlClient).onDialectOrElse({
        pg: () => Effect.void,
        orElse: () =>
          Context.get(context, SqlClient).unsafe(`PRAGMA busy_timeout = ${busyTimeoutMs}`).pipe(Effect.orDie)
      })
    )
  )
}

/**
 * The memory store and the recall that reads it, as one layer.
 *
 * `SMITHERS_MEMORY_DB` moves the store to its own SQLite file, opened with a
 * busy timeout so concurrent writers wait for each other instead of failing;
 * without it the store shares the workspace's `stores`. Recall is keyword
 * recall over the same store, so a note written by one run is what the next
 * one reads. Expired facts are deleted on the `Maintenance.layerTtlGc`
 * schedule while the layer is alive.
 *
 * @since 1.0.0
 * @private
 */
export const layer = (input: {
  readonly environment: Environment.Source
  readonly database: (filename: string) => Layer.Layer<DurableWriter.DurableWriter | SqlClient>
  readonly crypto: Layer.Layer<Crypto.Crypto>
  /** The workspace's own stores, used when `SMITHERS_MEMORY_DB` names no file. */
  readonly stores?: Layer.Layer<DurableWriter.DurableWriter | SqlClient> | undefined
}): Layer.Layer<MemoryStore.MemoryStore | Recall.Recall> => {
  const database = memoryDatabase(input)
  const store = MemoryStore.layer.pipe(Layer.provide(database), Layer.provide(input.crypto), Layer.orDie)
  return Layer.provideMerge(Maintenance.layerTtlGc(), Layer.provideMerge(RecallKeyword.layer, store))
}

/**
 * A run's opening memory: `memory({ task })` over the workspace, with the
 * facts of the explicitly named, granted banks. Wildcard resources never
 * enumerate a host's private banks. AgentSession seals the returned snapshot
 * for replay, so a resumed run opens with the same bytes.
 *
 * The workspace is read only when the launch holds the grant the `memory`
 * flow requires (`Memory.reads`) and the host is not `sealed`. Otherwise the
 * opening is the granted facts alone: `memory` reads no seed path unless the
 * repository is a source. A reading Jev did not answer is logged; the
 * granted facts still open the run, judged by the run-start reading.
 * @since 0.1.0
 * @private
 */
export const opening = (launch: {
  readonly runId: string
  readonly prompt: string
  readonly history: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
}, host: { readonly root: string; readonly sealed: boolean }) =>
  Effect.gen(function*() {
    const patterns = launch.capabilities.flatMap((value) => Option.toArray(Capability.parsePattern(value)))
    const ceiling = CapabilitySet.intersect(yield* CapabilitySet.current, CapabilitySet.fromPatterns(patterns))
    const banks = [
      ...new Set(
        patterns.filter((pattern) =>
          pattern.action.startsWith("memory:") && !/[?*]/.test(pattern.resource) &&
          CapabilitySet.allows(ceiling, Capability.make("memory:read", pattern.resource))
        ).map((pattern) => pattern.resource)
      )
    ]
    const readsWorkspace = !host.sealed && CapabilitySet.allows(ceiling, Memory.reads)
    const facts = yield* Effect.context<MemoryStore.MemoryStore | Recall.Recall>()
    const selected = yield* Memory.select({
      task: [launch.prompt, ...launch.history.slice(-6)].join("\n"),
      maxBytes: Memory.openingMaxBytes,
      ...(readsWorkspace ? {} : { sources: ["facts" as const] })
    }, {
      root: host.root,
      ...(banks.length === 0 ? {} : { facts: { services: facts, banks } })
    })
    if (selected.unjudged !== undefined) {
      const { detail, reason } = selected.unjudged
      yield* Effect.logWarning("memory opening unjudged", { runId: launch.runId, reason, detail })
    }
    return Memory.declared(selected)
  }).pipe(
    // The session seals this step with a JSON error channel; an Error
    // instance would surface as a schema defect instead of this failure.
    Effect.mapError((failure) => ({ _tag: failure._tag, code: failure.code, message: failure.message }))
  )
