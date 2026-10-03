/** Machine-only pinned source seam; production admission supplies this binding. */
import { Effect, FileSystem } from "effect"
import { isAbsolute, relative, sep } from "node:path"

/** Copied from the TODO/attempt/checkpoint in the Starting transaction (§4.1). */
export interface TodoFlowPin {
  readonly flowName: string
  readonly sourceCommit: string
  readonly digest: string
  readonly runId: string
  readonly attempt: number
  readonly todoId: number
  readonly machineId: string
}

/** Install-owned machine adapter; unavailable until the dependency checks pass. */
export interface PinnedTodoSource {
  readonly pin: TodoFlowPin
  readonly provider?: {
    /**
     * Resolve current TODO/attempt/run/machine authority from durable records.
     * Refuse unless T-STK-01/FLW-03/FLW-11/INS-02/FLW-01/SEC-01 are available
     * and C-SEC-02 is qualified. Never accept a caller's qualification assertion.
     */
    readonly validate: (pin: TodoFlowPin) => Effect.Effect<void, unknown>
    /**
     * Retain this exact commit as a separate immutable checkout in the machine.
     * Resolve dependencies there as the unprivileged agent, using installed
     * @smthrs packages. No host execution or editable-branch fallback.
     */
    readonly materialize: (pin: TodoFlowPin) => Effect.Effect<string, unknown>
  } | undefined
}

const inside = (parent: string, child: string) => {
  const path = relative(parent, child)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

/** Validate authority before materializing or reading any repository source. */
export const preparePinnedSource = (branchRoot: string, source: PinnedTodoSource) =>
  Effect.gen(function*() {
    const pin = Object.freeze({ ...source.pin })
    if (
      pin.flowName !== "todo" || !/^[a-f0-9]{40}$/.test(pin.sourceCommit) ||
      !/^[a-f0-9]{64}$/.test(pin.digest) || pin.runId === "" || pin.machineId === "" ||
      !Number.isSafeInteger(pin.attempt) || pin.attempt < 1 ||
      !Number.isSafeInteger(pin.todoId) || pin.todoId < 1
    ) return yield* Effect.fail(new Error("invalid TODO flow pin"))
    const provider = source.provider
    if (provider === undefined) return yield* Effect.fail(new Error("pinned machine source provider unavailable"))
    yield* provider.validate(pin)
    const root = yield* provider.materialize(pin)
    if (!isAbsolute(root)) return yield* Effect.fail(new Error("pinned source requires an absolute checkout"))
    const fs = yield* FileSystem.FileSystem
    const branch = yield* fs.realPath(branchRoot)
    const pinned = yield* fs.realPath(root)
    if (inside(branch, pinned) || inside(pinned, branch)) {
      return yield* Effect.fail(new Error("pinned source must be separate from the editable branch"))
    }
    return pinned
  }).pipe(Effect.mapError((cause) =>
    new Error(`infra: ${cause instanceof Error ? cause.message : "pinned source unavailable"}`, { cause })
  ))
