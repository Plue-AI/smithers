/** Revision checks are ordinary actions over Plue's read-only JJ tree export. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import { Clock, Effect, Layer, Path, Schema, Semaphore } from "effect"
import { contained, type ImmutableSourceOptions, runSourceProcess, withImmutableSource } from "./immutable-source.ts"
import { Check, checkInputDigest, CodingError, Implementation, Receipt } from "./schema.ts"

/** The registered Markdown flow's verified body, never an agent's check result. */
const Command = Schema.Struct({
  argv: Schema.NonEmptyArray(Schema.NonEmptyString),
  cwd: Schema.String,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3_600_000)),
  // Pinned command metadata, never a guess from output or an agent's verdict.
  infraExitCodes: Schema.optionalKey(Schema.Array(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(255))
  ))
})
const Input = Schema.Struct({ implementation: Implementation, check: Check })

export const CheckCommand = Action.make("coding/check-command", {
  // Invocation includes the pinned body, so command changes change action keys.
  payload: Executable.Invocation,
  success: Receipt,
  error: CodingError,
  nondeterministic: true
})
export const checkDelegate = Flow.make("coding/CommandCheck", {
  payload: Executable.Invocation,
  success: Receipt,
  error: CodingError,
  body: (invocation) => CheckCommand.call(invocation)
})

export type CheckHostOptions = ImmutableSourceOptions & {
  /** Optional deployment resource limit; ordinary checks may run concurrently. */
  readonly concurrency?: number
}
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })

/** Supply this layer to the existing native action table and register checkDelegate. */
export const checkLayers = (options: CheckHostOptions) => {
  // Each check owns an exported tree, dependency install and build processes.
  // The deploying host owns its resource limit; standalone compositions retain
  // concurrent owner feedback, including cancellation of unrelated checks.
  const checks = options.concurrency === undefined ? undefined : Semaphore.makeUnsafe(options.concurrency)
  return Layer.mergeAll(
    Interpreter.layer(checkDelegate),
    CheckCommand.toLayer((invocation) =>
      Effect.gen(function*() {
        const { implementation, check } = yield* Schema.decodeUnknownEffect(Input)(invocation.input)
          .pipe(Effect.mapError(() => invalid("Check input must identify the implemented revision and declared check")))
        if (invocation.flow !== check.flow) return yield* invalid("The registered check flow does not match the plan")
        // MarkdownFlow appends resource context and encoded arguments after the
        // verified body. This recipe's declaration is the first nonempty JSON line.
        const command = yield* Effect.try({
          try: () => JSON.parse(invocation.prompt.trimStart().split(/\r?\n/, 1)[0] ?? "") as unknown,
          catch: () => invalid("The registered check body must be a JSON command declaration")
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Command)),
          Effect.mapError(() => invalid("The registered check body needs argv, relative cwd and a bounded timeoutMs"))
        )
        const fs = options.fs, path = yield* Path.Path
        if (!path.isAbsolute(command.argv[0]) && options.environment?.PATH === undefined) {
          return yield* invalid(
            "A relative check executable requires a host-supplied PATH; otherwise use an absolute executable"
          )
        }
        if (path.isAbsolute(command.cwd) || command.cwd.split(/[\\/]/).includes("..")) {
          return yield* invalid("Check cwd must remain inside the exported source tree")
        }
        return yield* withImmutableSource(options, implementation.head, (tree, root) =>
          Effect.gen(function*() {
            const cwd = yield* fs.realPath(path.resolve(root, command.cwd))
            if (!contained(root, cwd, path)) {
              return yield* invalid("Check cwd resolves outside its immutable source export")
            }
            // The Change's written paths, one per line, so a check can select
            // only the targets they affect (checks/affected-*).
            if (implementation.writes.some((file) => file.includes("\n"))) {
              return yield* invalid("A written path contains a line break; the check cannot name it")
            }
            const environment = { ...options.environment, SMITHERS_CHECK_FILES: implementation.writes.join("\n") }
            const startedAt = yield* Clock.currentTimeMillis
            const result = yield* runSourceProcess({ ...options, environment }, command.argv, cwd, command.timeoutMs)
            const finishedAt = yield* Clock.currentTimeMillis
            const passed = result.exitCode === 0
            const fault = command.infraExitCodes?.includes(result.exitCode) ? "infra" as const : "factory" as const
            return {
              checkId: check.id,
              target: check.target,
              tier: check.tier,
              change: implementation.change,
              commitId: tree.commitId,
              treeId: tree.treeId,
              inputDigest: checkInputDigest(implementation, check),
              status: passed ? "passed" as const : "failed" as const,
              ...(passed ? {} : { fault }),
              startedAt,
              finishedAt,
              evidence: JSON.stringify({
                argv: command.argv,
                cwd: command.cwd,
                exitCode: result.exitCode,
                stdout: result.stdout.text,
                stderr: result.stderr.text,
                truncated: result.stdout.truncated || result.stderr.truncated,
                fileCount: tree.fileCount
              }),
              findings: passed || fault === "infra" ?
                [] :
                [{
                  owner: implementation.change,
                  sourceCommitId: tree.commitId,
                  message: `${check.target} exited with code ${result.exitCode}`
                }]
            }
          }))
      }).pipe(
        Effect.scoped,
        (effect) => checks === undefined ? effect : checks.withPermits(1)(effect),
        Effect.mapError((error) =>
          error instanceof CodingError ? error : new CodingError({
            code: "execution",
            message: "Revision check could not execute or finish its temporary source cleanup" +
              (error instanceof Error ? `: ${error.message.slice(0, 2_048)}` : "")
          })
        )
      )
    )
  )
}
