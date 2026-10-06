/** Shared document-returning CLI launch Effects. @since 1.0.0 */
import { Control as ControlService, ControlSchema } from "@smthrs/control"
import { BudgetOnExceeded, deadlineMillis } from "@smthrs/registry/Descriptor"
import { Effect, Option } from "effect"
import { resolve } from "node:path"
import * as CliError from "../CliError.ts"
import * as Detached from "../Detached.ts"
import * as Environment from "../Environment.ts"
import * as Project from "../Project.ts"
import * as Unsupported from "../Unsupported.ts"
import * as RunReads from "./RunReads.ts"
import * as Settlement from "./Settlement.ts"
import { approval, decodeInput, selectedFlow } from "./RunControl.ts"
/**
 * Resume a parked run and return its settled receipt.
 * @category constructors
 * @since 1.0.0
 */
export const resume = (planOrRunId: string, allowCodeDrift = false, quiet = false) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    const parkSequence = yield* Settlement.latestResumablePark(control, planOrRunId)
    const key = parkSequence === undefined ? `cli:resume:${planOrRunId}` : `cli:resume:${planOrRunId}:${parkSequence}`
    const receipt = yield* control.resume({
      runId: planOrRunId,
      // A refused resume records no receipt, so the retry with the override
      // takes a key of its own rather than colliding with the refused one.
      idempotencyKey: allowCodeDrift ? `${key}:allow-code-drift` : key,
      ...(allowCodeDrift ? { allowCodeDrift } : {})
    })
    // The live host that parked the run drives it. This process waits only
    // for that host to take the resume up, then reports the run's status.
    if (receipt._tag === "Accepted" && receipt.handedTo !== undefined) {
      const run = yield* Settlement.awaitHandOff(control, planOrRunId, receipt.handedTo, parkSequence)
      return {
        ...receipt,
        status: run.status,
        ...(run.waitingReason === undefined ? {} : { waitingReason: run.waitingReason })
      }
    }
    const settlement = yield* Settlement.awaitOwnedRun(control, receipt, parkSequence, quiet)
    if (Settlement.wasDeclined(settlement) && receipt._tag === "Accepted" && receipt.runId !== undefined) {
      return yield* Effect.fail(Settlement.declined(receipt.runId, yield* RunReads.summary(control, receipt.runId)))
    }
    yield* Settlement.report(settlement)
    return Settlement.receiptDocument(receipt, settlement)
  })

/**
 * Execute a plan approval and return its settled receipt.
 * @category constructors
 * @since 1.0.0
 */
export const run = (payload: ControlService.ApprovalInput, wait = false, quiet = false) =>
  Effect.gen(function*() {
    const target = payload.target
    if (target._tag !== "Plan") {
      return yield* Effect.fail(new CliError.UsageError({ message: "run requires a plan approval payload" }))
    }
    const control = yield* ControlService.Control
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: target.planId,
      digest: target.digest,
      envelope: target.envelope,
      idempotencyKey: payload.idempotencyKey
    })
    yield* Detached.announceAdmission(receipt)
    const owned = yield* Settlement.awaitOwnedRun(control, receipt, undefined, quiet)
    const settlement = wait && owned === undefined && receipt._tag === "Accepted" && receipt.runId !== undefined
      ? yield* Settlement.awaitRun(control, receipt.runId, undefined, quiet)
      : owned
    if (Settlement.wasDeclined(settlement) && receipt._tag === "Accepted" && receipt.runId !== undefined) {
      return yield* Effect.fail(Settlement.declined(receipt.runId, yield* RunReads.summary(control, receipt.runId)))
    }
    yield* Settlement.report(settlement)
    return Settlement.receiptDocument(receipt, settlement)
  })


/**
 * Decode and execute a serialized plan approval.
 * @category constructors
 * @since 1.0.0
 */
export const execute = (serialized: string, quiet = false) => Effect.flatMap(approval(serialized), payload => run(payload, false, quiet))
const plannedBudget = (config: {
  readonly budgetTokens: Option.Option<number>
  readonly budgetMs: Option.Option<number>
  readonly budgetUsd: Option.Option<number>
  readonly onExceeded: Option.Option<BudgetOnExceeded>
  readonly deadline: Option.Option<string>
}): Effect.Effect<ControlSchema.Envelope["budget"] | undefined, CliError.UsageError> =>
  Effect.gen(function*() {
    const ceiling = (flag: string, value: Option.Option<number>) =>
      Option.isSome(value) && !(Number.isSafeInteger(value.value) && value.value > 0)
        ? Effect.fail(new CliError.UsageError({ message: `--${flag} must be a positive integer` }))
        : Effect.succeed(Option.getOrUndefined(value))
    const tokens = yield* ceiling("budget-tokens", config.budgetTokens)
    const milliseconds = yield* ceiling("budget-ms", config.budgetMs)
    const usd = Option.getOrUndefined(config.budgetUsd)
    if (usd !== undefined && !(Number.isFinite(usd) && usd > 0)) {
      return yield* Effect.fail(new CliError.UsageError({ message: "--budget-usd must be a positive dollar amount" }))
    }
    const onExceeded = Option.getOrUndefined(config.onExceeded)
    const deadline = Option.isNone(config.deadline) ? undefined : deadlineMillis(config.deadline.value)
    if (Option.isSome(config.deadline) && deadline === undefined) {
      return yield* Effect.fail(
        new CliError.UsageError({
          message: "--deadline must be a positive duration such as 30 minutes, or whole milliseconds"
        })
      )
    }
    if (
      tokens === undefined && milliseconds === undefined && usd === undefined && onExceeded === undefined &&
      deadline === undefined
    ) {
      return undefined
    }
    return {
      ...(tokens === undefined ? {} : { tokens }),
      ...(milliseconds === undefined ? {} : { milliseconds }),
      ...(usd === undefined ? {} : { usd }),
      ...(onExceeded === undefined ? {} : { onExceeded }),
      ...(deadline === undefined ? {} : { deadline })
    }
  })


/**
 * Inputs shared by canonical and compatibility launch commands.
 * @category models
 * @since 1.0.0
 */
export interface StartOptions {
  readonly flow: string
  readonly data: Option.Option<string>
  readonly wait: boolean
  readonly detached: boolean
  readonly quiet: boolean
  readonly remote: Option.Option<string>
  readonly mcpConfig: Option.Option<string>
  readonly root: Option.Option<string>
  readonly budgetTokens: Option.Option<number>
  readonly budgetMs: Option.Option<number>
  readonly budgetUsd: Option.Option<number>
  readonly onExceeded: Option.Option<BudgetOnExceeded>
  readonly deadline: Option.Option<string>
}
/**
 * Plan, approve and launch one flow.
 * @category constructors
 * @since 1.0.0
 */
export const start = (config: StartOptions) => Effect.gen(function*() {
  if (config.detached && Option.isSome(config.remote)) return yield* Effect.fail(new CliError.UnsupportedError({ message: "flow start -d spawns a local executor; run `smthrs flow start` attached against --remote" }))
  if (config.detached && config.wait) return yield* Effect.fail(new CliError.UsageError({ message: "--wait and --detached cannot be combined" }))
  const flowId = yield* selectedFlow(config.flow)
  if (Unsupported.isReservedFlow(flowId)) {
    return yield* Effect.fail(Unsupported.reservedFlowError("flow start", flowId))
  }
  const decodedInput = yield* decodeInput([], config.data)
  const budget = yield* plannedBudget(config)
  const control = yield* ControlService.Control
  const card = yield* control.plan({ flowId, input: decodedInput, ...(budget === undefined ? {} : { budget }) })
  // The bare `*` envelope grants every capability, and markdown discovery
  // substitutes it for a flow that declares none, so `up` never approves it
  // unseen. The operator reviews the card with `plan` and signs it with
  // `approve`.
  if (card.envelope.capabilities.includes("*")) {
    return yield* Effect.fail(
      new CliError.UsageError({
        message: `flow start will not approve ${flowId}: its envelope grants every capability ("*"). `
          + (card.warnings === undefined ? "" : `${card.warnings.map((warning) => warning.message).join("; ")}. `)
          + `Declare capabilities in the flow, or review it with \`smthrs flow plan ${flowId}\` and approve it with \`smthrs approvals approve\``
      })
    )
  }
  // Scope `run`: the approval authorizes this launch and its whole run, not
  // every future launch of the flow.
  yield* control.approve({ ...card.approval, scope: "run" })
  if (!config.detached) return yield* run({ ...card.approval, scope: "run" }, config.wait, config.quiet)

  const projectRoot = yield* Project.ProjectRoot
  const timeoutMs = Environment.readInteger(process.env, "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS")
  const passthrough = [
    // The child runs with the project root as its cwd. An absolute MCP path
    // preserves the file the parent parsed when the flag was relative.
    ...(Option.isNone(config.mcpConfig)
      ? []
      : ["--mcp-config", resolve(process.cwd(), config.mcpConfig.value)]),
    ...(Option.isNone(config.root) ? [] : ["--root", projectRoot])
  ]
  // Each `up` plans afresh, so the plan id is this launch's alone. An id the
  // child's log announces is trusted only when this process's own control
  // store holds that run under this plan: the log is shared with every tool
  // the run spawns, and they inherit the admission nonce.
  const planId = card.approval.target._tag === "Plan" ? card.approval.target.planId : undefined
  const admission = (runId: string) =>
    Effect.runPromise(
      RunReads.summary(control, runId).pipe(
        Effect.map((summary) => planId !== undefined && summary !== undefined && summary.planId === planId)
      )
    )
  const launched = yield* Effect.callback<Detached.Launched | Detached.Rejected>((resume, signal) => {
    const pending = Detached.launch({
      root: projectRoot,
      payload: JSON.stringify({ ...card.approval, scope: "run" }),
      passthrough,
      signal,
      admission,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    })
    pending.then((result) => resume(Effect.succeed(result)), (error) => resume(Effect.die(error)))
    // Interruption aborts the signal first. Wait for termination and reaping
    // before the CLI scope can close and the process can exit.
    return Effect.promise(() => pending.then(() => undefined, () => undefined))
  })
  if (!Detached.isLaunched(launched)) {
    return yield* Effect.fail(
      new CliError.UnsupportedError({
        message: `${launched.reason}\nLog: ${launched.logFile}${launched.tail === "" ? "" : `\n${launched.tail}`}`
      })
    )
  }
  // The receipt's own field, never an operator-supplied id: rc.0 has no
  // `--run-id`, and a caller reads the run id from here.
  return { runId: launched.runId, logFile: launched.logFile, detached: true }

})

/**
 * Grant an approval and settle any run this executor owns.
 * @category constructors
 * @since 1.0.0
 */
export const approve = (serialized: string, scope: ControlService.ApprovalInput["scope"] = "run", quiet = false) => Effect.gen(function*() {
  const payload = yield* approval(serialized)
  const control = yield* ControlService.Control
  const parkSequence = yield* Settlement.decisionPark(control, payload.target)
  const receipt = yield* control.approve({ ...payload, scope })
  // A decision restarts the run it answers, in this call, on this process's
  // own executor. The decision therefore ends with
  // a settled run, and the shell that ran `smthrs approve` is entitled to
  // read that run's status from `$?` exactly as `up` and `run` promise it.
  const settlement = yield* Settlement.awaitOwnedRun(control, receipt, parkSequence, quiet)
  yield* Settlement.report(settlement)
  return Settlement.receiptDocument(receipt, settlement)

})

/**
 * Deny an approval and settle any run this executor owns.
 * @category constructors
 * @since 1.0.0
 */
export const deny = (serialized: string, quiet = false) => Effect.gen(function*() {
  const payload = yield* approval(serialized)
  const control = yield* ControlService.Control
  const parkSequence = yield* Settlement.decisionPark(control, payload.target)
  const receipt = yield* control.deny(payload)
  const settlement = yield* Settlement.awaitOwnedRun(control, receipt, parkSequence, quiet)
  yield* Settlement.report(settlement)
  return Settlement.receiptDocument(receipt, settlement)

})
