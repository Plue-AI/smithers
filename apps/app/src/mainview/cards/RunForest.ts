/*
 * The run forest: one run's graph with everything around it drawn as nodes of
 * the same grammar (UX pass 2026-09-28, web Graph).
 *
 * The canvas draws one execution's nodes. Around them this module adds, all
 * read off data the card and the open cards already hold:
 *
 * - the child executions that execution launched (`.child()` flows, a
 *   `coding/Poc` lane), each one collapsed to a node hung off the node whose
 *   action names its flow — the engine records a child's flow as its
 *   parent node's action, so that is the join, not a guess;
 * - the execution above the drawn one, once a reader has opened a child;
 * - the detached runs `agent/spawn` recorded (`Subagents.childRuns`);
 * - the run this one was spawned by, when its card is open (`parentRunOf`);
 * - the push or schedule that started the run (`RunTrigger`).
 *
 * Every added node carries the door its Open button runs: an execution opens
 * in place (`runs.graph.execution`), a run opens its own card (`runs.open`).
 */
import { flowArgs } from "../flows/FlowArgs"
import type { Card } from "../state/AppState"
import { childRuns, runStatus, type ChildRun } from "../state/Subagents"
import { engineRunEvidence, type EngineExecutionEvidence } from "./EngineTrace"
import { foldRunGraph, runGraphOf, type RunExecutionGraph, type RunGraphEdge, type RunGraphNode } from "./FlowGraphStatus"
import { runTriggersOf } from "./RunTrigger"

type RunCard = Extract<Card, { kind: "run-trace" }>

/** A proof-of-concept lane: it answers questions and never lands. */
export const isPocFlow = (flow: string | undefined): boolean => flow !== undefined && /(^|\/)poc$/i.test(flow)

/** An execution's engine status in the words the rest of the app shows. */
const EXECUTION_WORDS: Readonly<Record<string, string>> = {
  pending: "requested", running: "running", waiting: "waiting", completed: "done", failed: "failed", cancelled: "cancelled"
}

export const executionNodeId = (executionId: string): string => `exec:${executionId}`
export const runNodeId = (runId: string): string => `run:${runId}`

/** Nodes nothing inside the drawn graph waits on: where an arrow from outside lands. */
const rootsOf = (nodes: ReadonlyArray<RunGraphNode>): ReadonlyArray<string> =>
  nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id)

export interface RunForest {
  readonly nodes: ReadonlyArray<RunGraphNode>
  readonly edges: ReadonlyArray<RunGraphEdge>
}

/**
 * What the forest reads off one payload's journal, folded once per payload:
 * the executions the run owns, which of them recorded a graph (only those can
 * be opened in place), and the runs it spawned. A journal runs to tens of
 * thousands of rows and the forest is asked again whenever any card in the
 * conversation changes, so the fold lives exactly as long as the payload.
 *
 * The whole journal is read, never the scrub cursor: the graph fold beside it
 * (`foldRunGraph`) reads the whole journal too, and the two must agree.
 */
interface ForestEvidence {
  readonly executions: ReadonlyArray<EngineExecutionEvidence>
  readonly drawable: ReadonlySet<string>
  readonly children: ReadonlyArray<ChildRun>
}
const evidence = new WeakMap<RunCard["payload"], ForestEvidence>()
const evidenceOf = (card: RunCard): ForestEvidence => {
  const held = evidence.get(card.payload)
  if (held !== undefined) return held
  const events = card.payload.events ?? []
  const made: ForestEvidence = {
    executions: engineRunEvidence(events, card.payload.runId).executions,
    drawable: new Set(foldRunGraph(events).executions.filter((execution) => execution.nodes.length > 0).map((execution) => execution.executionId)),
    children: childRuns(card, true)
  }
  evidence.set(card.payload, made)
  return made
}

/** Whether a reader can open this execution in place: the journal recorded a graph for it. */
export const drawableExecution = (card: RunCard, executionId: string): boolean => evidenceOf(card).drawable.has(executionId)

/**
 * The execution a run card draws: the one a reader opened, while the journal
 * still records it with nodes, else the one the plan or the flow names
 * (`runGraphOf`). Both the canvas and the controller that validates a select
 * read it here, so they never disagree about which nodes exist.
 */
export const drawnGraphOf = (card: RunCard): {
  readonly drawn: RunExecutionGraph | undefined
  readonly opened: boolean
  readonly defaultExecutionId: string | undefined
} => {
  const planNodeIds = (card.payload.plan?.nodes ?? []).map((node) => node.id)
  const fold = foldRunGraph(card.payload.events)
  const byDefault = runGraphOf(fold, { ...(planNodeIds.length === 0 ? {} : { planNodeIds }), flow: card.payload.workflow })
  const wanted = card.payload.graph?.execution
  const opened = wanted === undefined ? undefined
    : fold.executions.find((execution) => execution.executionId === wanted && execution.nodes.length > 0)
  return { drawn: opened ?? byDefault, opened: opened !== undefined, defaultExecutionId: byDefault?.executionId }
}

/**
 * The node that launched a child execution: the ONE drawn node whose action
 * names the child's flow. The engine's child id is a digest and names no
 * parent node, so the action is the only join, and it is refused where it is
 * ambiguous — two nodes calling the same flow, or a wrapper node whose action
 * is the drawn execution's own flow. An unanchored child still draws, with no
 * edge claiming where it came from.
 */
const anchorOf = (nodes: ReadonlyArray<RunGraphNode>, flow: string | undefined, self: string | undefined): RunGraphNode | undefined => {
  if (flow === undefined || flow === self) return undefined
  const matches = nodes.filter((node) => node.action === flow)
  return matches.length === 1 ? matches[0] : undefined
}

/** The run that spawned this one, among the same repository's open run cards. */
const parentRunCard = (cards: ReadonlyArray<Card>, card: RunCard): RunCard | undefined =>
  cards.find((held): held is RunCard => held.kind === "run-trace" && held.id !== card.id &&
    held.payload.repo === card.payload.repo && held.payload.workspaceId === card.payload.workspaceId &&
    evidenceOf(held).children.some((child) => child.runId === card.payload.runId))

/**
 * The drawn execution's graph plus the forest around it.
 *
 * `executionId` is the execution the canvas is drawing; `defaultExecutionId`
 * is the one it draws when nobody opened another, so going back up to it
 * clears the reader's choice instead of recording it. Spawned runs, the
 * spawning run and the trigger belong to the run as a whole, so they are
 * drawn beside the run's own execution only.
 */
export const runForestOf = (
  card: RunCard,
  cards: ReadonlyArray<Card>,
  drawn: { readonly nodes: ReadonlyArray<RunGraphNode>; readonly edges: ReadonlyArray<RunGraphEdge> },
  executionId: string | undefined,
  defaultExecutionId: string | undefined
): RunForest => {
  const { runId, repo } = card.payload
  const nodes: Array<RunGraphNode> = [...drawn.nodes]
  const edges: Array<RunGraphEdge> = [...drawn.edges]
  const roots = rootsOf(drawn.nodes)
  const forest = evidenceOf(card)
  const open = (id: string | undefined) =>
    ({ flow: "runs.graph.execution" as const, args: flowArgs("runs.graph.execution", { runId, ...(id === undefined ? {} : { executionId: id }) }) })
  const openRun = (id: string) => ({ flow: "runs.open" as const, args: flowArgs("runs.open", { runId: id, repo }) })
  const ownRun = executionId === defaultExecutionId

  if (executionId !== undefined) {
    const self = forest.executions.find((execution) => execution.executionId === executionId)
    /* The execution above: the way back up, until the default is on screen. */
    const parent = ownRun ? undefined : forest.executions.find((execution) => execution.executionId === self?.parentExecutionId)
    if (parent !== undefined) {
      const id = executionNodeId(parent.executionId)
      const back = parent.executionId === defaultExecutionId || forest.drawable.has(parent.executionId)
      nodes.push({ id, kind: "flow", dependsOn: [], tier: "sealed", forest: true, word: EXECUTION_WORDS[parent.status] ?? parent.status,
        ...(parent.flowName === undefined ? {} : { action: parent.flowName }),
        ...(back ? { door: open(parent.executionId === defaultExecutionId ? undefined : parent.executionId) } : {}) })
      for (const root of roots) edges.push({ from: id, to: root })
    }
    for (const child of forest.executions) {
      if (child.parentExecutionId !== executionId) continue
      const anchor = anchorOf(drawn.nodes, child.flowName, self?.flowName)
      const poc = isPocFlow(child.flowName)
      const id = executionNodeId(child.executionId)
      nodes.push({ id, kind: poc ? "poc" : "flow", dependsOn: anchor === undefined ? [] : [anchor.id], tier: "sealed", forest: true,
        word: EXECUTION_WORDS[child.status] ?? child.status,
        ...(child.flowName === undefined ? {} : { action: child.flowName }),
        /* A child that recorded no graph yet has nothing to open. */
        ...(forest.drawable.has(child.executionId) ? { door: open(child.executionId) } : {}) })
      if (anchor !== undefined) edges.push({ from: anchor.id, to: id, ...(poc ? { reason: "poc" as const } : {}) })
    }
  }
  if (!ownRun) return { nodes, edges }

  /* Detached runs this run spawned: from its one entry node, else unanchored. */
  const entry = roots.length === 1 ? roots[0] : undefined
  const runCards = cards.filter((held): held is RunCard => held.kind === "run-trace" && held.payload.repo === repo &&
    held.payload.workspaceId === card.payload.workspaceId)
  for (const child of forest.children) {
    const id = runNodeId(child.runId)
    if (nodes.some((node) => node.id === id)) continue
    const held = runCards.find((candidate) => candidate.payload.runId === child.runId)
    nodes.push({ id, kind: "run", dependsOn: entry === undefined ? [] : [entry], tier: "sealed", forest: true, action: child.title,
      word: held === undefined ? "requested" : runStatus(held), door: openRun(child.runId) })
    if (entry !== undefined) edges.push({ from: entry, to: id, reason: "spawn" })
  }

  /* The run that spawned this one, when this client holds its card. */
  const parent = parentRunCard(runCards, card)
  if (parent !== undefined) {
    const id = runNodeId(parent.payload.runId)
    nodes.push({ id, kind: "run", dependsOn: [], tier: "sealed", forest: true, action: parent.payload.workflow,
      word: runStatus(parent), door: openRun(parent.payload.runId) })
    for (const root of roots) edges.push({ from: id, to: root, reason: "spawn" })
  }

  /* What started it: a push or a schedule is a root of the forest. */
  runTriggersOf(card).forEach((trigger, index) => {
    if (trigger.kind === "approval") return
    const id = `origin:${index}`
    nodes.push({ id, kind: "trigger", dependsOn: [], tier: "sealed", forest: true,
      action: trigger.kind === "push" ? trigger.ref : trigger.slug, word: trigger.kind })
    for (const root of roots) edges.push({ from: id, to: root, reason: "fires" })
  })

  return { nodes, edges }
}
