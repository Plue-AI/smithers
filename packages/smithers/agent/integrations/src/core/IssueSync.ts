/** Shared issue sync transport: PostgreSQL owns claims, identities and receipts.
 * @since 1.0.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import type { FlowRuntime } from "@smthrs/flow"
import { Schema } from "effect"
import { IntegrationFailure } from "./ActionFailure.ts"
import type { ExternalEvent } from "./ExternalEvent.ts"

/** Persisted connector routing.
 * @category schemas
 * @since 1.0.0
 */
export const Mapping = Schema.Struct({
  provider: Schema.String,
  connection_id: Schema.String,
  scope_id: Schema.String,
  conversation_id: Schema.String,
  thread_id: Schema.String
})
/** A committed issue event awaiting a provider receipt.
 * @category schemas
 * @since 1.0.0
 */
export const Delivery = Schema.Struct({
  id: Schema.Int,
  key: Schema.String,
  issue_id: Schema.Int,
  state: Schema.String,
  event: Schema.String,
  payload: Schema.Struct({
    comment: Schema.Struct({
      id: Schema.Int,
      body: Schema.optional(Schema.String),
      persona: Schema.optional(Schema.Unknown)
    }),
    reaction: Schema.optional(Schema.Struct({ name: Schema.String, active: Schema.Boolean }))
  }),
  message_id: Schema.String,
  /** The claim fencing a `dispatching` row; its execution identity survives a lost receipt. */
  claim_token: Schema.optional(Schema.String),
  mapping: Mapping
})
/** The connector implements only provider admission and durable action calls.
 * `deliver` must run on a durable Flow runtime whose journal outlives the host:
 * a lapsed claim is recovered by re-executing its original execution id.
 * @category models
 * @since 1.0.0
 */
export interface Connector {
  readonly accepts: (mapping: typeof Mapping.Type) => boolean
  readonly deliver: (
    delivery: typeof Delivery.Type,
    executionId: string
  ) => Promise<{ messageId: string; unsupported?: string }>
  readonly reconcile: (delivery: typeof Delivery.Type, executionId: string) => Promise<string | undefined>
}
/** Host ports; the host owns scheduling and durable signal admission.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly owner: string
  readonly repo: string
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly connector: Connector
  readonly onMessage?:
    | ((receipt: { readonly issueId: number; readonly event: ExternalEvent }) => Promise<void>)
    | undefined
}
/** Refuse volatile runtimes before intake or outbound claims can be acknowledged.
 * @category guards
 * @since 1.0.0
 */
export const requireDurableRuntime = (runtime: FlowRuntime.FlowRuntime["Service"]): void => {
  if (runtime?.durability !== "durable") {
    throw new Error("Issue sync requires a durable engine store; FlowEngine.layerMemory cannot replay after restart")
  }
}
const failureOf = (value: unknown): IntegrationFailure | undefined => {
  const pending = [value]
  const seen = new Set<unknown>()
  while (pending.length > 0 && seen.size < 20) {
    const next = pending.shift()
    if (seen.has(next)) continue
    seen.add(next)
    if (Schema.is(IntegrationFailure)(next)) return next
    if (isRecord(next)) pending.push(next["cause"], next["error"])
  }
  return undefined
}
const decodeDeliveries = Schema.decodeUnknownSync(Schema.Array(Delivery))

/** Build the one claim/execute/settle mechanism used by every connector.
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options) => {
  const base = `/api/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/issues/sync`
  const request = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    const response = await options.request(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    })
    if (!response.ok) {
      throw Object.assign(new Error(`Issue sync ${method} ${path}: HTTP ${response.status}`), {
        status: response.status
      })
    }
    return response.json()
  }
  // 409: another worker already settled this row (a replayed lapsed claim), so this receipt is moot.
  const settle = async (id: number, receipt: unknown): Promise<boolean> => {
    try {
      await request(`/deliveries/${id}`, "PUT", receipt)
      return true
    } catch (error) {
      if (isRecord(error) && error["status"] === 409) return false
      throw error
    }
  }
  const ingest = async (body: unknown, event?: ExternalEvent): Promise<"ignored" | "applied"> => {
    let receipt: unknown
    for (let attempt = 0;; attempt++) {
      try {
        receipt = await request("/events", "POST", body)
        break
      } catch (error) {
        // A post can reach the provider before its backend receipt commits.
        // Keep the same intake identity during this short race. Exhaustion
        // fails the source without acknowledging, preserving provider retry.
        const reaction = isRecord(body) && (body["kind"] === "reaction_add" || body["kind"] === "reaction_remove")
        if (!reaction || !isRecord(error) || error["status"] !== 409 || attempt === 3) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
      }
    }
    // A routine refusal (unmapped conversation, disallowed user) is acknowledged, not retried.
    if (isRecord(receipt) && typeof receipt["ignored"] === "string") return "ignored"
    if (
      event !== undefined && options.onMessage !== undefined && isRecord(receipt) &&
      typeof receipt["issue_id"] === "number"
    ) await options.onMessage({ issueId: receipt["issue_id"], event })
    return "applied"
  }
  const listDeliveries = async () => {
    const all: Array<typeof Delivery.Type> = []
    let after = 0
    while (true) {
      const page = decodeDeliveries(await request(after === 0 ? "/deliveries" : `/deliveries?after_id=${after}`))
      all.push(...page)
      if (page.length < 100) return all
      const next = page[page.length - 1]!.id
      if (next <= after) throw new Error("Issue delivery cursor did not advance")
      after = next
    }
  }
  const drain = async (): Promise<number> => {
    const deliveries = await listDeliveries()
    let completed = 0
    const unsettled: Array<unknown> = []
    for (const initial of deliveries) {
      if (!options.connector.accepts(initial.mapping)) continue
      const d = (await listDeliveries()).find((row) => row.id === initial.id)
      if (d === undefined) continue
      // The backend reveals a dispatching claim's token only after its lease lapses.
      let token = d.state === "dispatching" ? d.claim_token ?? "" : ""
      if (d.state === "dispatching" && token === "") continue
      if (d.state !== "pending" && token === "") {
        if (d.event !== "comment.created") continue
        const found = await options.connector.reconcile(d, `issue-sync-reconcile:${d.id}:${crypto.randomUUID()}`)
        if (found !== undefined) {
          if (await settle(d.id, { state: "sent", message_id: found, token: "" })) completed++
        }
        continue
      }
      if (token === "") {
        const claim = await request(`/deliveries/${d.id}`, "POST")
        if (!isRecord(claim) || claim["state"] !== "dispatching" || typeof claim["token"] !== "string") continue
        token = claim["token"]
      }
      // The claim's execution identity is durable: re-executing it after a lost
      // receipt replays the journaled outcome instead of acting again.
      let result: Awaited<ReturnType<Connector["deliver"]>>
      try {
        result = await options.connector.deliver(d, `issue-sync:${d.id}:${token}`)
      } catch (error) {
        const failure = failureOf(error)
        const partial = (failure?.deliveredMessageIds?.length ?? 0) > 0
        await settle(d.id, {
          state: failure !== undefined && failure.outcomeUnknown !== true && !partial ? "failed" : "outcome_unknown",
          token,
          message_id: partial ? failure!.deliveredMessageIds!.join(",") : d.message_id,
          error: failure?.message ?? "Delivery did not settle; reconcile before retrying"
        })
        continue
      }
      // A failed receipt write leaves the row dispatching for replay; it is not an unknown outcome.
      try {
        const settled = await settle(d.id, {
          state: result.unsupported === undefined ? "sent" : "unsupported",
          token,
          message_id: result.messageId,
          ...(result.unsupported === undefined ? {} : { error: result.unsupported })
        })
        if (settled) completed++
      } catch (error) {
        unsettled.push(error)
      }
    }
    if (unsettled.length > 0) throw new AggregateError(unsettled, "Issue delivery receipts did not commit")
    return completed
  }
  return { ingest, drain }
}
