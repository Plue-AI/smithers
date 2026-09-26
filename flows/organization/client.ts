/**
 * The organization host's control plane, as a client reaches it: the same
 * `Plan` / `Approve` / `Run` / `List` / `Signal` procedures the product app
 * speaks, over the gateway's loopback RPC, plus the three things an operator
 * does with them here — submit a request, read what is running, and answer a
 * gate.
 *
 * `Operations` is written against a {@link Control} port so the host's own
 * Slack intake and the CLI share one implementation: the host passes its
 * in-process control plane, the CLI passes {@link rpc}.
 */
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Gates from "../../packages/smithers/agent/organization/src/Gates.ts"
import type { Request } from "./schema.ts"

/** The control procedures an operator uses, by their RPC tags. */
export interface Control {
  readonly call: (tag: "Plan" | "Approve" | "Run" | "List" | "Signal", payload: unknown) => Promise<any>
}

/** A control call the host refused, with the tag of the refusal. */
export class ControlRefused extends Error {
  readonly tag: string
  readonly procedure: string
  constructor(tag: string, procedure: string, message: string) {
    super(`${procedure} refused (${tag}): ${message}`)
    this.tag = tag
    this.procedure = procedure
  }
}

/**
 * The file in a state directory holding the host's bearer credential: the
 * host writes it on first start (mode 600), every `/rpc`, `/projections`, and
 * `/sync` request must present it, and client commands read it from here.
 * Removing it and restarting the host rotates it.
 */
export const credentialFile = (stateDir: string): string => join(stateDir, "credential")

/** The host credential a state directory holds, or `undefined` before its host's first start. */
export const readCredential = (stateDir: string): string | undefined => {
  try {
    const credential = readFileSync(credentialFile(stateDir), "utf8").trim()
    return credential === "" ? undefined : credential
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** The loopback gateway's control RPC at `base`, such as `http://127.0.0.1:7433`, as `credential`. */
export const rpc = (base: string, credential?: string): Control => {
  let id = 0
  return {
    call: async (tag, payload) => {
      const response = await fetch(`${base}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/ndjson",
          ...(credential === undefined || credential === "" ? {} : { authorization: `Bearer ${credential}` })
        },
        body: `${JSON.stringify({ _tag: "Request", id: String(++id), tag, payload, headers: [] })}\n`
      })
      const text = await response.text()
      const lines = text.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line))
      const exit = lines.find((line) => line._tag === "Exit")?.exit
      if (exit === undefined) {
        const defect = lines.find((line) => line._tag === "Defect")
        throw new Error(
          `${tag}: the host answered no result${defect === undefined ? "" : `: ${JSON.stringify(defect.defect)}`}`
        )
      }
      if (exit._tag === "Success") return exit.value
      const failure =
        (exit.cause as ReadonlyArray<{ _tag: string; error?: { _tag?: string; message?: string }; defect?: unknown }>)
          .find((reason) => reason._tag === "Fail")?.error
      throw new ControlRefused(failure?._tag ?? "Defect", tag, failure?.message ?? JSON.stringify(exit.cause))
    }
  }
}

/** One run as the operator sees it. */
export interface RunView {
  readonly runId: string
  readonly flowId: string
  readonly status: string
  readonly gates: ReadonlyArray<GateView>
}

/** One approval gate a run is parked on. */
export interface GateView {
  readonly runId: string
  readonly gateId: string
  readonly subjectDigest: string
  readonly prompt: string
  readonly wait: string
}

const gatesOf = (
  run: { readonly runId: string; readonly pendingWaits?: ReadonlyArray<any> }
): ReadonlyArray<GateView> =>
  (run.pendingWaits ?? []).flatMap((wait) => {
    const pending = Gates.pending(wait.request)
    return pending === undefined || typeof wait.name !== "string" ? [] : [{
      runId: run.runId,
      gateId: pending.gateId,
      subjectDigest: pending.subjectDigest,
      prompt: pending.prompt,
      wait: wait.name
    }]
  })

/** A request key a CLI submission is deduplicated by. */
export const cliKey = (key?: string): string => `cli:${key ?? randomUUID()}`

/** What an operator does with the control plane. */
export const operations = (control: Control) => {
  const runs = async (filters: Readonly<Record<string, unknown>> = {}): Promise<ReadonlyArray<RunView>> => {
    const views: Array<RunView> = []
    let cursor: string | undefined
    do {
      const page = await control.call("List", { _tag: "runs", filters, ...(cursor === undefined ? {} : { cursor }) })
      for (const run of page.items) {
        views.push({ runId: run.runId, flowId: run.flowId, status: run.status, gates: gatesOf(run) })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return views
  }

  /** Plans, approves, and starts one flow under `key`; the same key joins the run it started. */
  const start = async (
    flowId: string,
    input: unknown,
    key: string
  ): Promise<{ readonly runId: string; readonly joined: boolean }> => {
    const plan = await control.call("Plan", { flowId, input, idempotencyKey: `plan:${key}` })
    try {
      await control.call("Approve", { ...plan.approval, idempotencyKey: `approve:${key}` })
    } catch (error) {
      if (!(error instanceof ControlRefused && error.tag.endsWith("AlreadyResolved"))) throw error
    }
    const receipt = await control.call("Run", {
      _tag: "Plan",
      planId: plan.planId,
      digest: plan.digest,
      envelope: plan.envelope,
      idempotencyKey: `run:${key}`
    })
    if (receipt.runId === undefined) throw new Error(`the host did not start ${flowId}: ${JSON.stringify(receipt)}`)
    return { runId: receipt.runId, joined: receipt._tag !== "Accepted" }
  }

  return {
    start,
    /**
     * Starts `organization/intake` for a request, deduplicated by its key: a
     * second submission of the same key joins the first run.
     */
    submit: (request: Request) => start("organization/intake", { request }, request.key),
    /** Rewrites the organization's status page, once per call. */
    writeStatus: () => start("organization/status", {}, `status:${randomUUID()}`),
    runs,
    /** Every approval gate parked anywhere. */
    gates: async () => (await runs({ status: "waiting-approval" })).flatMap((run) => run.gates),
    /**
     * Answers an approval gate by its id. `runId` picks one when several runs
     * wait on the same gate.
     */
    answer: async (options: {
      readonly gateId: string
      readonly approved: boolean
      readonly runId?: string | undefined
      readonly reason?: string | undefined
    }): Promise<GateView> => {
      const open = (await runs({ status: "waiting-approval" })).flatMap((run) => run.gates)
        .filter((gate) =>
          gate.gateId === options.gateId && (options.runId === undefined || gate.runId === options.runId)
        )
      if (open.length === 0) throw new Error(`no run is waiting on gate ${options.gateId}`)
      if (open.length > 1) {
        throw new Error(
          `${open.length} runs wait on gate ${options.gateId}; pass --run with one of ${
            open.map((gate) => gate.runId).join(", ")
          }`
        )
      }
      const gate = open[0]!
      await control.call("Signal", {
        runId: gate.runId,
        signal: {
          name: gate.wait,
          payload: {
            approved: options.approved,
            subjectDigest: gate.subjectDigest,
            ...(options.reason === undefined ? {} : { reason: options.reason })
          }
        },
        idempotencyKey: `answer:${gate.runId}:${gate.gateId}:${gate.subjectDigest.slice(0, 16)}`
      })
      return gate
    }
  }
}
