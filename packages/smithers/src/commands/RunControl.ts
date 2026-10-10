/** Shared document-returning CLI control Effects. @since 1.0.0 */
import * as Canonical from "@smthrs/canonical/Canonical"
import { Control as ControlService, ControlSchema } from "@smthrs/control"
import * as Sha256 from "@smthrs/crypto/Sha256"
import { Effect, Option, Schema, SchemaIssue } from "effect"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { text } from "node:stream/consumers"
import * as CliError from "../CliError.ts"
import * as NodeOutput from "../NodeOutput.ts"
import * as Project from "../Project.ts"
import * as Ui from "../Ui.ts"
import * as Unsupported from "../Unsupported.ts"
import * as FlowCatalog from "./FlowCatalog.ts"
import * as RunReads from "./RunReads.ts"
import * as Settlement from "./Settlement.ts"
/**
 * Resolve a supplied flow name or an interactive selection.
 * @category constructors
 * @since 1.0.0
 */
export const selectedFlow = (value: string) =>
  Effect.gen(function*() {
    if (value !== "") return value
    const ui = yield* Ui.prompting
    const control = yield* ControlService.Control
    const catalog = yield* flowCatalog(control)
    const flows = catalog.items.filter((item) => !Unsupported.isReservedFlow(item.flowId))
    if (flows.length === 0) {
      return yield* Effect.fail(
        new CliError.UsageError({ message: "No flows discovered; run smthrs init to create one" })
      )
    }
    const selected = yield* ui.pickSuggestion(flows, {
      message: "Choose a flow",
      label: (flow) => flow.flowId,
      hint: (flow) => flow.description
    })
    if (Option.isNone(selected)) return yield* Effect.interrupt
    return selected.value.flowId
  })

const malformedJson = (label: string): CliError.UsageError =>
  new CliError.UsageError({ message: `${label} must be valid JSON` })

const formatSchemaIssue = SchemaIssue.makeFormatterDefault()

const schemaMismatch = (label: string, issue: SchemaIssue.Issue): CliError.UsageError => {
  // Approval payloads can carry capability material. Input reporting stays
  // disabled at the decoder, and this bounded formatter keeps only the path
  // and expectation an operator needs to repair one field.
  const detail = formatSchemaIssue(issue).split("\n").slice(0, 4).join("\n").slice(0, 800)
  return new CliError.UsageError({
    message: `${label} must match the expected payload schema:\n${detail}`
  })
}

const decodeJson = <A>(
  label: string,
  serialized: string,
  decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>
): Effect.Effect<A, CliError.UsageError> =>
  Effect.try({
    try: () => JSON.parse(serialized) as unknown,
    catch: () => malformedJson(label)
  }).pipe(
    Effect.flatMap((decoded) =>
      decode(decoded).pipe(
        Effect.mapError((error) => schemaMismatch(label, error.issue))
      )
    )
  )

/**
 * Merge JSON input over positional key=value entries.
 * @category constructors
 * @since 1.0.0
 */
export const decodeInput = (
  entries: ReadonlyArray<string>,
  raw: Option.Option<string>
): Effect.Effect<unknown, CliError.UsageError> => {
  const pairs = Object.fromEntries(entries.map((entry) => {
    const separator = entry.indexOf("=")
    return separator < 1 ? [entry, true] : [entry.slice(0, separator), entry.slice(separator + 1)]
  }))
  if (Option.isNone(raw)) return Effect.succeed(pairs)
  const source = raw.value
  const serialized = source === "-"
    ? Effect.tryPromise({
      try: () => text(process.stdin),
      catch: () => new CliError.UsageError({ message: "Could not read --data from stdin" })
    })
    : source.startsWith("@")
    ? Effect.tryPromise({
      try: () => readFile(source.slice(1), "utf8"),
      catch: () => new CliError.UsageError({ message: `Could not read --data file ${source.slice(1)}` })
    })
    : Effect.succeed(source)
  return serialized.pipe(
    Effect.flatMap((value) =>
      Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: () => malformedJson("--data")
      })
    ),
    Effect.map((decoded) =>
      decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
        ? { ...pairs, ...(decoded as Record<string, unknown>) }
        : { ...pairs, data: decoded }
    )
  )
}

/**
 * Decode an approval without exposing capability payloads in errors.
 * @category constructors
 * @since 1.0.0
 */
export const approval = (serialized: string): Effect.Effect<ControlService.ApprovalInput, CliError.UsageError> =>
  decodeJson(
    "approval",
    serialized,
    Schema.decodeUnknownEffect(ControlSchema.ApprovalPayload, { reportInput: false })
  )

/**
 * Decode a named signal payload.
 * @category constructors
 * @since 1.0.0
 */
export const signal = (serialized: string): Effect.Effect<ControlSchema.SignalPayload, CliError.UsageError> =>
  decodeJson(
    "signal-json",
    serialized,
    Schema.decodeUnknownEffect(ControlSchema.SignalPayload, { reportInput: false })
  )

const flowCatalog = FlowCatalog.read
/**
 * Identify one signal mutation by its canonical payload digest.
 * @category constructors
 * @since 1.0.0
 */
export const signalKey = (runId: string, payload: ControlSchema.SignalPayload): string => {
  const encoded = Schema.encodeSync(ControlSchema.SignalPayload)(payload)
  const canonical = Schema.decodeUnknownSync(Canonical.Canonical)(encoded)
  return `cli:signal:${runId}:${Sha256.digestSync(canonical)}`
}

/**
 * Compile a non-reserved flow with its decoded input.
 * @category constructors
 * @since 1.0.0
 */
export const plan = (flow: string, entries: ReadonlyArray<string>, data: Option.Option<string>) =>
  Effect.gen(function*() {
    const input = yield* decodeInput(entries, data)
    const flowId = yield* selectedFlow(flow)
    if (Unsupported.isReservedFlow(flowId)) {
      return yield* Effect.fail(Unsupported.reservedFlowError("flow plan", flowId))
    }
    const control = yield* ControlService.Control
    return yield* control.plan({ flowId, input })
  })
/**
 * Read the complete project flow listing.
 * @category constructors
 * @since 1.0.0
 */
export const listFlows = Effect.gen(function*() {
  const control = yield* ControlService.Control
  const catalog = yield* FlowCatalog.read(control)
  const { items, apps } = FlowCatalog.listing(catalog.items, yield* Project.ProjectRoot)
  return { _tag: "flows" as const, items, ...(apps === undefined ? {} : { apps }) }
})
/**
 * Read projected output for a run or one node.
 * @category constructors
 * @since 1.0.0
 */
export const output = (runId: string, nodeId?: string) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    yield* RunReads.existing(control, runId)
    const nodes = NodeOutput.project(yield* RunReads.events(control, runId))
    if (nodeId === undefined) return nodes
    const node = nodes.find((candidate) => candidate.nodeId === nodeId)
    if (node === undefined) {
      return yield* Effect.fail(new CliError.UsageError({ message: NodeOutput.notFound(runId, nodeId, nodes) }))
    }
    return node
  })
const reportTerminal = (receipt: ControlSchema.Receipt) =>
  Settlement.report(receipt._tag === "Terminal" ? { kind: `control.run.${receipt.status}` } : undefined)

/**
 * Cancel a run with a stable mutation key.
 * @category constructors
 * @since 1.0.0
 */
export const cancel = (runId: string) =>
  Effect.flatMap(
    ControlService.Control,
    (control) => control.cancel({ runId, idempotencyKey: `cli:cancel:${runId}` }).pipe(Effect.tap(reportTerminal))
  )
/**
 * Deliver a signal with a payload-specific mutation key.
 * @category constructors
 * @since 1.0.0
 */
export const deliverSignal = (runId: string, serialized: string) =>
  Effect.gen(function*() {
    const payload = yield* signal(serialized)
    const control = yield* ControlService.Control
    return yield* control.signal({ runId, signal: payload, idempotencyKey: signalKey(runId, payload) }).pipe(
      Effect.tap(reportTerminal)
    )
  })
/**
 * Deliver an attributed operator steering message.
 * @category constructors
 * @since 1.0.0
 */
export const steer = (runId: string, body: string) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    const stamp = Date.now()
    const messageId = `cli:steer:${runId}:${randomUUID()}`
    return yield* control.steer({
      runId,
      message: {
        kind: "Message",
        messageId,
        runId,
        principal: { kind: "operator", id: "cli", stampedAt: stamp },
        createdAt: stamp,
        body
      },
      idempotencyKey: messageId
    })
  })
