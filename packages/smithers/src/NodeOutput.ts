/**
 * The node-output projection `smthrs output` and the MCP `get_node_detail`
 * tool both read.
 *
 * A run's journal records every flow call an agent made and how it settled.
 * What an operator asks for afterwards is narrower: "what did that one step
 * produce?" This module is that question, computed from the `ControlEvent`
 * deltas `Control.watch` already serves, so the answer is identical for a
 * local run and a `--remote` one and no command reaches past the control
 * plane into a store.
 *
 * A node's identity is `<flowName>#<ordinal>`, the ordinal counting that
 * flow's distinct calls within the run from 1. Durable `callId` joins starts
 * and settlements; legacy name/FIFO matching applies only to idless starts.
 * Repeated identified lifecycle events do not renumber later nodes.
 * The public node identity is stable for a settled
 * run — the journal is append-only and the ordinal is its order — which is
 * what a reference in a report or a follow-up command needs. The reserved id
 * `result` names the run's final assistant output.
 *
 * @since 1.0.0
 */

import type { ControlSchema } from "@smthrs/control"
import { asRecord, asString, callScope, openCallIndex, uniqueCallEvents } from "@smthrs/gateway/Diagnosis"

/**
 * The reserved node id for the run's final output.
 *
 * @category constants
 * @since 1.0.0
 */
export const resultNodeId = "result"

/**
 * One node's recorded output.
 *
 * @category models
 * @since 1.0.0
 */
export interface Node {
  readonly nodeId: string
  readonly flowName: string
  /** Durable dispatch identity; absent on legacy journal records. */
  readonly callId?: string | undefined
  readonly outcome: "success" | "failure" | "pending"
  readonly input?: unknown
  readonly value?: unknown
  readonly message?: string | undefined
  readonly startedAt?: number | undefined
  readonly settledAt?: number | undefined
  /**
   * The sequence of the event that started this call, and of the one that
   * settled it.
   *
   * Ordinals are assigned within one projection, so they only mean the same
   * thing across two projections of the same events. A delta reader that
   * projected a filtered slice to find what changed renumbered the second
   * `bash` call as `bash#1` and then read the first call's output. Carrying
   * the sequences lets a caller ask what moved after a cursor from the ONE
   * run-wide projection instead.
   */
  readonly startedSequence?: number | undefined
  readonly settledSequence?: number | undefined
}

/**
 * Projects a run's events into its node outputs, in the order they started.
 *
 * A call that started and never settled is reported `pending` rather than
 * dropped: a run that died mid-call is exactly when an operator asks what the
 * last step was doing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const project = (events: ReadonlyArray<ControlSchema.ControlEvent>): ReadonlyArray<Node> => {
  const ordinals = new Map<string, number>()
  const open: Array<Node> = []
  const nodes: Array<Node> = []
  let finalOutput: string | undefined
  let finalAt: number | undefined
  let finalSequence: number | undefined

  for (const event of uniqueCallEvents(events)) {
    const payload = asRecord(event.payload)
    if (event.kind === "control.agent.cell-call-started") {
      const flowName = asString(payload["flowName"]) ?? "?"
      const ordinal = (ordinals.get(flowName) ?? 0) + 1
      ordinals.set(flowName, ordinal)
      const node: Node = {
        nodeId: `${flowName}#${ordinal}`,
        flowName,
        ...(typeof payload["callId"] === "string" ? { callId: payload["callId"] } : {}),
        outcome: "pending",
        input: payload["input"],
        startedAt: event.occurredAt,
        startedSequence: event.sequence
      }
      open.push(node)
      nodes.push(node)
      continue
    }
    if (event.kind === "control.agent.cell-call-settled") {
      const flowName = asString(payload["flowName"]) ?? "?"
      // Dispatch identity survives concurrent same-name calls. Legacy
      // fallback may claim only an unidentified start, including old runs
      // that resume with a newly identified settlement after an upgrade.
      const index = openCallIndex(open, asString(payload["callId"]), flowName)
      if (index < 0) continue
      const [node] = open.splice(index, 1)
      const position = nodes.indexOf(node!)
      nodes[position] = {
        ...node!,
        outcome: asString(payload["outcome"]) === "failure" ? "failure" : "success",
        value: payload["value"],
        message: asString(payload["message"]),
        settledAt: event.occurredAt,
        settledSequence: event.sequence
      }
      continue
    }
    // `result` is THE run's answer, so only the run's own resolution may set
    // it. `uniqueCallEvents` also normalizes a module run's step facts, and a
    // step agent's answer is the step's, not the run's. A prompt run records
    // one unscoped stream and reads exactly as it did.
    if (event.kind === "control.agent.resolved" && callScope(event) === undefined) {
      finalOutput = asString(payload["text"])
      finalAt = event.occurredAt
      finalSequence = event.sequence
    }
  }

  if (finalOutput !== undefined) {
    nodes.push({
      nodeId: resultNodeId,
      flowName: "agent",
      outcome: "success",
      value: finalOutput,
      settledAt: finalAt,
      settledSequence: finalSequence
    })
  }
  return nodes
}

/**
 * Finds one node by id.
 *
 * @category getters
 * @since 1.0.0
 */
export const find = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  nodeId: string
): Node | undefined => project(events).find((node) => node.nodeId === nodeId)

/**
 * The message printed when a node id names nothing, listing what the run has.
 *
 * An operator who guessed a node id needs the real ones, and a run with no
 * recorded calls at all is a different problem than a mistyped id.
 *
 * @category constructors
 * @since 1.0.0
 */
export const notFound = (runId: string, nodeId: string, nodes: ReadonlyArray<Node>): string =>
  nodes.length === 0
    ? `Run ${runId} recorded no node output.`
    : `Run ${runId} has no node ${nodeId}. It has: ${nodes.map((node) => node.nodeId).join(", ")}`

/**
 * The human rendering of one node: its outcome line, then its value.
 *
 * @category conversions
 * @since 1.0.0
 */
export const render = (node: Node): string => {
  const value = typeof node.value === "string" ? node.value : JSON.stringify(node.value, null, 2) ?? ""
  const detail = node.message === undefined ? "" : `\n${node.message}`
  return `${node.nodeId} ${node.outcome}${detail}${value === "" ? "" : `\n${value}`}`
}
