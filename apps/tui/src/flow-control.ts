/**
 * The real `Flows.Port`: the native control host `smthrs up` drives, composed
 * for the current runtime and opened in-process. Discovery reads the registry only; warming
 * imports the project's flow modules.
 */
import { NodeServices } from "@effect/platform-node"
import * as BunControl from "@smthrs/cli/BunControl"
import * as NodeControl from "@smthrs/cli/NodeControl"
import { Control, type ControlSchema } from "@smthrs/control"
import * as Diagnosis from "@smthrs/gateway/Diagnosis"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { executionDigest } from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { existsSync } from "node:fs"
import { join } from "node:path"
import * as Approvals from "./approvals.ts"
import * as Extension from "./extension.ts"
import { FlowError, type Port, type Settled, terminal } from "./flows.ts"
import type { Host } from "./host.ts"

type ControlEvent = ControlSchema.ControlEvent
const NativeControl = process.versions.bun === undefined ? NodeControl : BunControl
interface Opened {
  readonly runtime: ManagedRuntime.ManagedRuntime<Control.Control, never>
  readonly catalog: Executable.Catalog
}

/** A control-plane or host failure as the typed error the tab shows. */
const typed = (error: unknown): FlowError => {
  if (error instanceof FlowError) return error
  const failure = Exit.isExit(error) && Exit.isFailure(error) ? Cause.squash(error.cause) : error
  const tag = (failure as { _tag?: string })?._tag ?? ""
  const message = tag.endsWith("InvalidInput")
    ? String((failure as { issue?: unknown }).issue)
    : failure instanceof Error
    ? failure.message
    : String(failure)
  return new FlowError(tag.endsWith("InvalidInput") ? "invalid_input" : "control", message || tag || "Control failed", {
    cause: failure
  })
}

const payloadOf = (event: ControlEvent): Record<string, unknown> =>
  event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {}

/** The completed run's answer: a module's committed result, or the agent's final text (as `smthrs up`). */
const answerOf = (events: ReadonlyArray<ControlEvent>): string =>
  Diagnosis.resolvedOutput(Diagnosis.digest(events)) ?? ""

export const make = (options: {
  readonly cwd: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly approvals: NonNullable<Host["approvals"]>
  /** Where `control.db` and `engine.db` live; default `<cwd>/.flows`, like `smthrs up`. */
  readonly stateRoot?: string
}): Port => {
  const judge = NodeControl.layerSeatEvaluator(options.environment).pipe(
    Layer.provide(
      process.versions.bun === undefined
        ? NodeControl.layerRebuildableRequestExecutor(NodeControl.environmentDispatcher(options.environment))
        : RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))
    )
  )
  const registry = () => NativeControl.layerRegistry(options.cwd)
  let opening: Promise<Opened> | undefined

  const open = (): Promise<Opened> => {
    opening ??= (async () => {
      const catalog = await Effect.runPromise(
        Executable.catalog({ delegates: [] }).pipe(Effect.provide(registry()), Effect.provide(NodeServices.layer))
      )
      const modules = Layer.mergeAll(
        Executable.layerRefreshable(catalog, { delegates: [], refreshable: () => false }),
        ...catalog.executables.map((entry) => entry.layer)
      )
      const runtime = ManagedRuntime.make(
        NativeControl.layerControl(
          {
            root: options.cwd,
            startsRuns: true,
            approvalChannel: true,
            evaluator: judge,
            ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot })
          },
          undefined,
          undefined,
          modules
        )
      )
      return { runtime, catalog }
    })().catch((error) => {
      opening = undefined
      throw typed(error)
    })
    return opening
  }

  const control = async <A>(use: (control: Control.Service) => Effect.Effect<A, unknown>): Promise<A> => {
    const { runtime } = await open()
    const exit = await runtime.runPromiseExit(Control.Control.pipe(Effect.flatMap(use)))
    if (Exit.isSuccess(exit)) return exit.value
    throw typed(Cause.squash(exit.cause))
  }

  const markdown = (flow: string): Promise<boolean> =>
    Effect.runPromise(
      Registry.Registry.pipe(Effect.flatMap((each) => each.getOption(flow)), Effect.provide(registry()))
    ).then((descriptor) => descriptor._tag === "Some" && descriptor.value.body._tag === "Markdown", () => false)

  const events = (runId: string): Promise<ReadonlyArray<ControlEvent>> =>
    control((service) => service.watch({ runId, follow: false }).pipe(Stream.runCollect)).then((events) => [...events])

  return {
    warm: () => existsSync(join(options.cwd, "flows")) ? control(() => Effect.void) : Promise.resolve(),
    discover: () =>
      Effect.runPromise(
        Registry.Registry.pipe(Effect.flatMap((each) => each.list()), Effect.provide(registry()))
      ).then(
        (listed) => listed.map(Extension.project),
        (error) => {
          throw typed(error)
        }
      ),
    // A fresh registry each read, so an edited agent file applies to the next launch.
    body: (flow) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const each = yield* Registry.Registry
          const descriptor = yield* each.getOption(flow)
          if (descriptor._tag === "None") {
            return yield* Effect.fail(new FlowError("unknown_flow", `Unknown flow ${flow}`))
          }
          if (descriptor.value.body._tag !== "Markdown") {
            return yield* Effect.fail(new FlowError("refused", `${flow} is a module flow; run it with /flow`))
          }
          const body = yield* each.loadBody(flow)
          if (body._tag !== "Prompt") return yield* Effect.fail(new FlowError("refused", `${flow} has no prompt body`))
          const declared = descriptor.value.frontmatter["capabilities"]
          return {
            text: body.text,
            baseDirectory: body.baseDirectory,
            digest: executionDigest(descriptor.value) ?? "",
            ...(Array.isArray(declared) && declared.every((each) => typeof each === "string")
              ? { capabilities: declared }
              : typeof declared === "string"
              ? { capabilities: declared.split(/\s+/).filter((each) => each !== "") }
              : {})
          }
        }).pipe(Effect.provide(registry()))
      ).catch((error) => {
        throw typed(error)
      }),
    input: async (flow) => {
      const { catalog } = await open()
      const found = catalog.executables.find((entry) => entry.descriptor.name === flow)
      if (found !== undefined) return found.input
      // A markdown flow is a prompt flow: the control plane runs its body itself and
      // takes any JSON input, so the catalog's delegate refusal does not apply to it.
      if (await markdown(flow)) return undefined
      const refused = catalog.refused.find((entry) => entry.flow === flow)
      if (refused !== undefined) {
        const cause = refused.cause instanceof Error ?
          refused.cause.message
          : typeof refused.cause === "string"
          ? refused.cause
          : undefined
        const reason = cause?.split("\n")[0]
        throw new FlowError("refused", reason ? `${refused.message}: ${reason}` : refused.message, { cause: refused })
      }
      throw new FlowError("unknown_flow", `Unknown flow ${flow}`)
    },
    plan: (flow, input) =>
      control((service) => service.plan({ flowId: flow, input: input })).then((card) => ({
        // Wildcards take the same y/n/a rows as every consequential envelope, in `start`.
        raw: card
      })),
    start: async (card, source = "chat", signal) => {
      const raw = card.raw as ControlSchema.PlanCard
      try {
        await options.approvals.authorize(
          Approvals.project(raw.flowId, raw.envelope.capabilities, options.cwd, source),
          signal
        )
        if (signal?.aborted) throw new FlowError("refused", "Stopped")
      } catch (error) {
        throw new FlowError("refused", signal?.aborted ? "Stopped" : typed(error).message)
      }
      return control((service) =>
        Effect.gen(function*() {
          const raw = card.raw as ControlSchema.PlanCard
          // Scope `run`, as `smthrs up`: this launch and its whole run, not every future launch.
          const approval = { ...raw.approval, scope: "run" as const }
          yield* service.approve(approval)
          const target = approval.target
          if (target._tag !== "Plan") return yield* Effect.fail(new FlowError("launch", "Not a plan approval"))
          const receipt = yield* service.run({
            _tag: "Plan",
            planId: target.planId,
            digest: target.digest,
            envelope: target.envelope,
            idempotencyKey: approval.idempotencyKey
          })
          if ((receipt._tag === "Accepted" || receipt._tag === "AlreadyApplied") && receipt.runId !== undefined) {
            return receipt.runId
          }
          return yield* Effect.fail(
            new FlowError(
              "launch",
              receipt._tag === "Terminal"
                ? `Run ${receipt.status}`
                : receipt._tag === "Conflict"
                ? receipt.message
                : `Launch ${receipt._tag}`
            )
          )
        })
      )
    },
    resume: async (runId): Promise<{ runId: string } | Settled> => {
      const receipt = await control((service) =>
        service.resume({ runId, idempotencyKey: `tui:resume:${runId}:${Date.now()}` })
      )
      if (receipt._tag !== "Terminal") {
        return "runId" in receipt && receipt.runId !== undefined
          ? { runId: receipt.runId }
          : { runId }
      }
      // The engine finished before the TUI recorded it; the answer is in the journal.
      if (receipt.status === "completed") return { kind: "done", answer: answerOf(await events(runId)) }
      return receipt.status === "cancelled"
        ? { kind: "cancelled" }
        : { kind: "failed", message: `Run ${receipt.status}` }
    },
    watch: (runId, onEvent) => {
      const seen: Array<ControlEvent> = []
      let fiber: Fiber.Fiber<unknown, unknown> | undefined
      let closed = false
      const done = open().then(({ runtime }) => {
        if (closed) return new Promise<never>(() => {})
        const program = Control.Control.pipe(
          Effect.flatMap((service) =>
            service.watch({ runId, follow: true }).pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  seen.push(event)
                  onEvent(event)
                })
              ),
              Stream.filter((event) => terminal.has(event.kind)),
              Stream.runHead
            )
          )
        )
        fiber = runtime.runFork(program)
        return Effect.runPromise(Fiber.await(fiber))
      }).then((exit): Settled => {
        if (Exit.isFailure(exit)) {
          throw new FlowError("control", `Control watch failed: ${typed(Cause.squash(exit.cause)).message}`)
        }
        const last = exit.value as { _tag: string; value?: ControlEvent }
        const event = last._tag === "Some" ? last.value : undefined
        if (event === undefined) throw new FlowError("control", "Control watch ended")
        if (event.kind === "control.run.completed") return { kind: "done", answer: answerOf(seen) }
        if (event.kind === "control.run.cancelled") return { kind: "cancelled" }
        if (event.kind === "control.run.pending") return { kind: "failed", message: "Declined" }
        const payload = payloadOf(event)
        // The cause carries a stack; the tab and the coordinator get its first line.
        const cause = Diagnosis.firstLine(String(payload["cause"] ?? payload["message"] ?? "")).trim()
        return { kind: "failed", message: Diagnosis.clip(cause === "" ? "Failed" : cause, 200) }
      })
      return {
        done,
        close: () => {
          closed = true
          if (fiber !== undefined) void Effect.runPromise(Fiber.interrupt(fiber))
        }
      }
    },
    events,
    runs: async () => {
      const list = (service: Control.Service) =>
        service.list({ _tag: "runs", order: "newest", limit: 20 }).pipe(
          Effect.map((page) =>
            page._tag === "runs"
              ? page.items.map((run) => ({ runId: run.runId, flow: run.flowId, status: run.status }))
              : []
          )
        )
      // The open host when a run already opened it; else an observing one that imports nothing, as `smthrs ps`.
      if (opening !== undefined) return control(list)
      // Never create a store just to find it empty.
      if (!existsSync(join(options.stateRoot ?? options.cwd, ".flows", "control.db"))) return []
      const exit = await Effect.runPromiseExit(
        Control.Control.pipe(
          Effect.flatMap(list),
          Effect.provide(
            NativeControl.layerControl({
              root: options.cwd,
              startsRuns: false,
              ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot })
            })
          )
        )
      )
      if (Exit.isSuccess(exit)) return exit.value
      throw typed(Cause.squash(exit.cause))
    },
    cancel: (runId) =>
      control((service) => service.cancel({ runId, idempotencyKey: `tui:cancel:${runId}`, reason: "Stopped" })).then(
        () => undefined
      ),
    dispose: async () => {
      const current = opening
      opening = undefined
      if (current === undefined) return
      const { runtime } = await current.catch(() => ({ runtime: undefined }))
      await runtime?.dispose()
    }
  }
}
