import { createElement } from "react"
import { createRoot } from "react-dom/client"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { createAppStore } from "../../state/AppStore"
import { createAppController } from "../../state/AppController"
import { applicationIdentityFromFetch, silentAgent } from "../../state/TestFixtures"
import type { Card } from "../../state/AppState"
import type { FlowName } from "../../flows/FlowName"
import { RunTraceBody } from "../RunTraceCard.tsx"

// The real card, store and command registry, on an isolated local origin.
const stamp = (sequence: number, kind: string, at: number, payload = {}) => ({
  sequence, kind: `control.${kind}`, occurredAt: at, payload: { ...payload, at }
})
/** Two module steps in one journal, in the producer's own outbox envelope. */
const step = (scope: string, letter: string) => ({
  executionId: "execution", stepId: letter.repeat(64), action: "coding/edit", attempt: 1, ask: 0, retry: 1, scope, generation: 0
})
const LEFT = step("left", "a")
const RIGHT = step("right", "b")
const native = (sequence: number, kind: string, owner: typeof LEFT, at: number, payload = {}) => ({
  sequence, kind: "control.engine.event", occurredAt: at,
  payload: {
    version: 1, executionId: owner.executionId, generation: 1, sequence, emittedAtMs: at,
    sourceId: `step-fact-v1:${owner.stepId}:${owner.attempt}:${owner.ask}:${owner.retry}`,
    sourceSequence: sequence, eventType: "flows.harness.step-fact.v1",
    payload: { version: 1, step: owner, generation: 0, frame: 0, ordinal: 0, cell: "", at, eventType: kind, sourceSequence: sequence, payload }
  }
})

const scenario = new URLSearchParams(location.search).get("scenario")
const events = scenario === "interleaved" ? [
  // Both steps open before either records a moment, and every moment shares
  // one stamp: nothing but the recorded step can say whose frame it is.
  native(1, "control.agent.turn-opened", LEFT, 1000),
  native(2, "control.agent.turn-opened", RIGHT, 1000),
  native(3, "control.agent.read-only-demand-issued", LEFT, 1000, { streak: 4, cap: 4, nextFrame: 2 }),
  native(4, "control.agent.repeat-demanded", RIGHT, 1000, { frames: 4, cap: 4 }),
  native(5, "control.agent.narrow-only-demanded", LEFT, 1000, { flow: "bash", targets: ["tests"], nextFrame: 2 }),
  native(6, "control.agent.sufficiency-observed", RIGHT, 1000, { flow: "bash", failed: "a", passed: "b", nextFrame: 2 }),
  // One step reads while the other writes, on one stamp: the two bands cover
  // the same ground, so only the recorded step says which one a moment is in.
  native(7, "control.agent.cell-call-started", LEFT, 1000, { callId: "a1", flowName: "read", input: { path: "src/a.ts" } }),
  native(8, "control.agent.cell-call-started", RIGHT, 1000, { callId: "b1", flowName: "write", input: { path: "src/b.ts" } }),
  stamp(9, "run.completed", 5000)
] : scenario === "cluster" ? [
  stamp(1, "agent.turn-opened", 1000),
  stamp(2, "agent.read-only-demand-issued", 1200),
  stamp(3, "agent.repeat-demanded", 1201, { frames: 4, cap: 4 }),
  stamp(4, "agent.narrow-only-demanded", 1202),
  stamp(5, "agent.steering-drained", 1203),
  stamp(6, "agent.unmoved-demanded", 1204),
  stamp(7, "agent.unresolved-demanded", 1205),
  stamp(8, "agent.sufficiency-observed", 1206),
  stamp(9, "run.completed", 10000)
] : scenario === "gap" ? [
  // A wide band with nothing recorded inside it: the subject slept. The next
  // record is the following band's own frame, so the position nearest the end
  // of the wide band belongs to the band after it.
  stamp(1, "agent.turn-opened", 1000),
  stamp(2, "agent.cell-call-started", 1100, { flowName: "read", input: { path: "src/a.ts" } }),
  stamp(3, "agent.cell-call-settled", 1200, { flowName: "read", outcome: "success", value: "one line" }),
  stamp(4, "agent.turn-closed", 1300),
  stamp(5, "agent.turn-opened", 2000),
  stamp(6, "agent.turn-opened", 62100),
  stamp(7, "agent.cell-call-started", 62200, { flowName: "write", input: { path: "src/a.ts", content: "x" } }),
  stamp(8, "agent.cell-call-settled", 62300, { flowName: "write", outcome: "success" }),
  stamp(9, "agent.turn-closed", 62400),
  stamp(10, "run.completed", 62500)
] : scenario === "tail" || scenario === "tail-live" ? [
  // The journal's LAST record opens a frame, so the last band's seq is also
  // the last recorded position. A band door there asks for the latest
  // sequence, which is the case a production keyboard walk could not commit.
  stamp(1, "agent.turn-opened", 1000),
  stamp(2, "agent.cell-call-started", 1100, { flowName: "read", input: { path: "src/a.ts" } }),
  stamp(3, "agent.cell-call-settled", 1800, { flowName: "read", outcome: "success", value: "one line" }),
  stamp(4, "agent.turn-closed", 1900),
  stamp(5, "agent.turn-opened", 2000),
  stamp(6, "agent.cell-call-started", 2100, { flowName: "write", input: { path: "src/a.ts", content: "x" } }),
  stamp(7, "agent.cell-call-settled", 2800, { flowName: "write", outcome: "success" }),
  stamp(8, "agent.turn-closed", 2900),
  stamp(9, "agent.turn-opened", 3000)
] : scenario === "labels" || scenario === "live" ? [
  stamp(1, "agent.turn-opened", 1000),
  stamp(2, "agent.read-only-demand-issued", 1000),
  stamp(3, "agent.repeat-demanded", 3700, { frames: 4, cap: 4 }),
  stamp(4, "agent.sufficiency-observed", 4600),
  ...(scenario === "live" ? [] : [stamp(5, "run.completed", 10000)])
] : [
  ...[0, 1, 2, 3].flatMap((index) => [
    stamp(1 + index * 4, "agent.turn-opened", 1000 + index * 2000),
    stamp(2 + index * 4, "agent.cell-call-started", 1200 + index * 2000, { flowName: "read", input: { path: `src/${index}.ts` } }),
    stamp(3 + index * 4, "agent.cell-call-settled", 1800 + index * 2000, { flowName: "read", outcome: "success", value: `result ${index}` }),
    stamp(4 + index * 4, "agent.turn-closed", 1900 + index * 2000)
  ]),
  stamp(17, "run.completed", 9000)
]

const store = await createAppStore({ kind: "localStorage", storage: localStorage })
const cardId = "flow-run-strip-browser"
if (!store.collections.cards.has(cardId)) {
  const card: Extract<Card, { kind: "run-trace" }> = {
    id: cardId, kind: "run-trace", title: "Trace", status: "active", createdAt: 0, ordinal: 0,
    payload: { repo: "fixture/strip", workspaceId: "00000000-0000-4000-8000-00000000517a", runId: "strip-browser", workflow: "probe", phase: scenario === "live" || scenario === "tail-live" ? "running" : "completed", steps: [], result: null, lastSeq: events.length, events, traceView: "timeline", liveTail: true }
  }
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
}
const fetchImpl: FetchLike = async input => new URL(String(input), location.origin).pathname === "/api/user"
  ? new Response(null, { status: 401 })
  : new Response("{}", { status: 404 })
const controller = createAppController(store, silentAgent, {
  fetchImpl,
  applicationIdentity: applicationIdentityFromFetch(fetchImpl, location.origin),
  cloudSocketUrl: () => undefined,
  cloudLspSocketUrl: () => undefined
})
const root = createRoot(document.getElementById("fixture")!)
const commands: Array<{ name: string; args?: string }> = []
// A refused command is the product's own answer, so the probe reads it instead
// of inferring a refusal from a cursor that did not move.
const refusals: Array<{ name: string; args?: string; error: string }> = []
declare global {
  interface Window {
    runTraceBrowser: {
      cursor: number | "latest"
      selection: string
      commands: typeof commands
      refusals: typeof refusals
      appendMilestone: () => Promise<void>
      appendFrame: () => Promise<void>
    }
  }
}
const render = () => {
  const card = store.collections.cards.get(cardId)
  if (card?.kind !== "run-trace") throw new Error("The fixture run card is absent")
  root.render(createElement(RunTraceBody, { card, onRunCommand: run }))
  window.runTraceBrowser = { cursor: card.payload.cursorSeq ?? "latest", selection: card.payload.selection ?? "", commands, refusals, appendMilestone, appendFrame }
}
const run = (name: FlowName, args?: string) => {
  commands.push({ name, args })
  void controller.commands.run(name, args).then(async (result) => {
    await store.settled?.()
    if (result.status === "failed") refusals.push({ name, args, error: result.error })
    render()
    if (result.status === "failed") throw new Error(result.error)
  })
}
/** One more frame of the phase the last band already holds: the band grows, it is not replaced. */
const appendFrame = async () => {
  const card = store.collections.cards.get(cardId)
  if (card?.kind !== "run-trace") throw new Error("The fixture run card is absent")
  const held = card.payload.events ?? []
  const next = held.length + 1
  await store.dispatch({ type: "card.updated", actor: "system", id: cardId, patch: { payload: {
    ...card.payload, events: [...held, stamp(next, "agent.turn-opened", 3000 + next * 100)], lastSeq: next
  } } }).isPersisted.promise
  render()
}
const appendMilestone = async () => {
  const card = store.collections.cards.get(cardId)
  if (card?.kind !== "run-trace") throw new Error("The fixture run card is absent")
  const next = (card.payload.events ?? []).length + 1
  await store.dispatch({ type: "card.updated", actor: "system", id: cardId, patch: { payload: {
    ...card.payload, events: [...(card.payload.events ?? []), stamp(next, "agent.repeat-demanded", 3700, { frames: 4, cap: 4 })], lastSeq: next
  } } }).isPersisted.promise
  render()
}
render()
