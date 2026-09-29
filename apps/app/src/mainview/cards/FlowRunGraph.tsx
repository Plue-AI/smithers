import { flowArgs } from "../flows/FlowArgs"
/*
 * The run's graph, on the run card's third view.
 *
 * The card already holds the run's journal (`events`, the `run-events`
 * projection the pump keeps current) and, for a run this client launched, the
 * plan it was approved on. This module joins the two: the graph the engine
 * recorded, with the state each of its nodes reached, and the camera on
 * whichever node is running.
 *
 * Everything here is a pure read of the card payload. The canvas itself loads
 * lazily, so a conversation holding a run card does not pull xyflow into the
 * main chunk until the reader opens the graph.
 */
import { Suspense, useMemo } from "react"
import { FlowRunGraphSurface } from "../ViewModules"
import { ViewSkeleton } from "../ViewSkeleton"
import { flowAction } from "../flows/FlowAction"
import type { Card, FlowDurationsRow } from "../state/AppState"
import type { RunCommand } from "./CardFamily"
import type { JournalRecord } from "./RunTrace"
import type { NodeRun, RunGraphEdge, RunGraphNode } from "./FlowGraphStatus"
import { drawnGraphOf, graphEventsOf, runForestOf } from "./RunForest"
import { runInputsOf } from "./RunInputs"
import { useCardRows } from "../state/useCardRows"
import type { CardProjectionAuthority } from "./CardFamily"

const EMPTY_DURATIONS: ReadonlyArray<FlowDurationsRow> = []

type RunTraceCard = Extract<Card, { kind: "run-trace" }>

/** The graph a run card can draw, and where its camera is pointed. */
export interface RunGraphView {
  readonly nodes: ReadonlyArray<RunGraphNode>
  readonly edges: ReadonlyArray<RunGraphEdge>
  readonly status: ReadonlyMap<string, NodeRun>
  /** The running node the camera follows; absent leaves the whole graph in frame. */
  readonly focusId?: string
  /** The execution these nodes were recorded under; absent when the plan is all the card has. */
  readonly executionId?: string
  /** The execution the card draws when no reader opened another (RunForest.ts). */
  readonly defaultExecutionId?: string
  /**
   * The revision the declaration sites on these nodes were read at, when
   * their source named one.
   *
   * It comes from the same source the nodes did — the recorded graph where
   * there is one, the plan snapshot otherwise — because a site says where a
   * node was declared and never which bytes were there (D-068).
   */
  readonly sourceRevision?: string
}

/**
 * The plan's own nodes, in the shape a graph draws, carrying the declaration
 * site the snapshot recorded for each one.
 *
 * The site is the graph builder's observation and never part of the key
 * material, so it rides beside the nodes (`plan.graph.nodes`); a node the
 * builder could not place carries none rather than a guessed one, and the
 * drawer's Code tab is absent for it (D-035).
 */
const planNodes = (card: RunTraceCard): ReadonlyArray<RunGraphNode> => {
  /* The plan card reads the same field the same way (FlowGraph.ts
   * `sitesByNode`); it is read here rather than imported because that module
   * carries dagre, which belongs to the lazily loaded canvas and not to the
   * chunk a conversation holding a run card already has. */
  const sites = new Map(
    (card.payload.plan?.graph?.nodes ?? []).flatMap((site) =>
      site.declaredAt === undefined ? [] : [[site.id, site.declaredAt] as const]
    )
  )
  return (card.payload.plan?.nodes ?? []).map((node) => {
    const declaredAt = sites.get(node.id)
    return {
      id: node.id,
      kind: node.kind,
      dependsOn: node.dependsOn,
      tier: node.tier,
      ...(node.action === undefined ? {} : { action: node.action }),
      ...(declaredAt === undefined ? {} : { declaredAt })
    }
  })
}

/**
 * The plan's edges: the labelled ones the workspace reported, and otherwise
 * the unlabelled `dependsOn` set every host carries.
 *
 * `dependsOn` says which nodes wait and never why, so an edge drawn from it
 * carries no reason at all. Labelling it `value` was this card stating the
 * one thing an edge says on behalf of a source that never said it — and the
 * wrong thing, for every `catch` arm and every ordering edge in the graph.
 */
const planEdges = (card: RunTraceCard, nodes: ReadonlyArray<RunGraphNode>): ReadonlyArray<RunGraphEdge> => {
  const labelled = card.payload.plan?.graph?.edges ?? []
  return labelled.length > 0
    ? labelled.map((edge) => ({ from: edge.from, to: edge.to, reason: edge.reason }))
    : nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id })))
}

/**
 * Whether this node is waiting, through however many nodes, on another node
 * that is also running.
 *
 * A composition stays `running` for as long as anything inside it runs, so a
 * node that is running AND waiting on a running node is a container of that
 * node rather than a place a run is. `dependsOn` is what says so; a node id
 * is an address, not a path, and reading one as a path would break on the
 * first flow that names a step after its parent.
 */
const waitsOnRunning = (
  id: string,
  dependsOn: ReadonlyMap<string, ReadonlyArray<string>>,
  running: ReadonlySet<string>
): boolean => {
  const seen = new Set<string>([id])
  const queue = [...dependsOn.get(id) ?? []]
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (seen.has(next)) continue
    seen.add(next)
    if (running.has(next)) return true
    queue.push(...dependsOn.get(next) ?? [])
  }
  return false
}

/**
 * The node the camera follows: the node the run is ON, which is not simply
 * the newest running one.
 *
 * A run parked on a gate three `.child()` boundaries down has THREE running
 * nodes: the gate, and the two compositions waiting for it (`root.flow`,
 * `root`). Those two are running only BECAUSE the gate is, and the camera can
 * only be in one place: framed on `root` a reader is shown the flow's own box
 * and loses the node they came to see. The engine stamps all three inside the
 * same millisecond often enough that "the one that started last" was handing
 * the camera to `root` on about one run in three of the flow-graph tier.
 *
 * So a running node waiting on another running node is not where the run is —
 * the one it waits on is. Among what is left, a fan-out really does run
 * several at once, and there the camera goes to the one that started last
 * rather than to whichever the node list happens to name first.
 *
 * Nothing running leaves the whole graph in frame.
 */
export const focusedRunNode = (
  nodes: ReadonlyArray<RunGraphNode>,
  status: ReadonlyMap<string, NodeRun>
): string | undefined => {
  const running = new Set(nodes.filter((node) => status.get(node.id)?.status === "running").map((node) => node.id))
  const dependsOn = new Map(nodes.map((node) => [node.id, node.dependsOn] as const))
  let focus: { readonly id: string; readonly at: number } | undefined
  for (const node of nodes) {
    if (!running.has(node.id) || waitsOnRunning(node.id, dependsOn, running)) continue
    const at = status.get(node.id)?.startedAt ?? 0
    if (focus === undefined || at >= focus.at) focus = { id: node.id, at }
  }
  return focus?.id
}

/*
 * The fold, keyed by the payload it came from (RunTraceCard.ts `folds`). A run
 * card's journal runs to tens of thousands of rows and every render would fold
 * it again — twice, because the view button asks the same question the view
 * does. A derivation keyed by the payload object is not card state: it lives
 * exactly as long as the payload it came from.
 */
const views = new WeakMap<RunTraceCard["payload"], { readonly view: RunGraphView | undefined }>()

/**
 * The graph this run card can draw, or nothing.
 *
 * The recorded graph wins whenever there is one: it is what actually ran, and
 * it is the only source that says WHY one node waited for another. The plan is
 * what a run card has before its first event arrives, and a run launched
 * elsewhere has neither until the engine's records land.
 */
export const runGraphOfCard = (card: RunTraceCard): RunGraphView | undefined => {
  const held = views.get(card.payload)
  if (held !== undefined) return held.view
  const view = graphOf(card)
  views.set(card.payload, { view })
  return view
}

const graphOf = (card: RunTraceCard): RunGraphView | undefined => {
  const plan = planNodes(card)
  const { drawn: recorded, opened, defaultExecutionId } = drawnGraphOf(card)
  const fromRecord = recorded !== undefined && recorded.nodes.length > 0
  const nodes = fromRecord ? recorded!.nodes : plan
  if (nodes.length === 0) return undefined
  const status = recorded?.status ?? new Map<string, NodeRun>()
  const focusId = focusedRunNode(nodes, status)
  /* The revision belongs to the source the nodes came from, never the other one. */
  const sourceRevision = fromRecord ? recorded!.sourceRevision : card.payload.plan?.graph?.sourceRevision
  return {
    nodes,
    edges: recorded !== undefined && recorded.edges.length > 0 ? recorded.edges
      : opened ? nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id })))
      : planEdges(card, nodes),
    status,
    ...(focusId === undefined ? {} : { focusId }),
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    ...(recorded === undefined ? {} : { executionId: recorded.executionId }),
    ...(defaultExecutionId === undefined ? {} : { defaultExecutionId })
  }
}

/**
 * The clock a running node measures its own elapsed time against.
 *
 * A node's `startedAt` is the moment the ENGINE emitted its schedule envelope
 * (`emittedAtMs`, FlowGraphStatus.ts), so the other end of that measurement
 * has to come off the same clock. A row's `occurredAt` is when the control
 * plane wrote it down, which trails the emission — by up to 290ms in the
 * recorded fixture — and would add that write lag, plus any skew between the
 * two hosts, to every elapsed time on the card. A card holding no engine
 * envelope has no engine clock, and then the newest row it has read is the
 * only "now" the run gives it.
 */
export const observedAtOf = (events: ReadonlyArray<JournalRecord> = []): number | undefined => {
  let emitted: number | undefined
  let written: number | undefined
  for (const event of events) {
    const at = (event.payload as { emittedAtMs?: unknown } | undefined)?.emittedAtMs
    if (event.kind === "control.engine.event" && typeof at === "number" && (emitted === undefined || at > emitted)) emitted = at
    if (typeof event.occurredAt === "number" && (written === undefined || event.occurredAt > written)) written = event.occurredAt
  }
  return emitted ?? written
}

/**
 * The graph view: a way back to the turns, the camera switch, and the canvas.
 *
 * The camera switch is a flow like every other act, so the agent and the
 * keyboard reach it too; pan and zoom stay the reader's own gestures.
 */
interface FlowRunGraphProps {
  readonly card: RunTraceCard
  readonly view: RunGraphView
  readonly onRunCommand: RunCommand
  /** Every measured row the session holds; this graph reads its own flow's. */
  readonly flowDurations?: ReadonlyArray<FlowDurationsRow>
  /** The files already read into this conversation; the drawer's Code tab renders the declared one. */
  readonly fileCards?: ReadonlyArray<Extract<Card, { kind: "file" }>>
  /** The open cards, read live, so the forest states its parent and child runs (RunForest.ts). */
  readonly childCards?: CardProjectionAuthority["collections"]["cards"] | undefined
}

const NO_CARDS: ReadonlyArray<Card> = []

const LiveFlowRunGraph = ({ collection, ...props }: FlowRunGraphProps & {
  readonly collection: NonNullable<FlowRunGraphProps["childCards"]>
}) => <RunGraphBody {...props} cards={useCardRows(collection)} />

/** The run forest's graph, reading the open cards live when the store is there. */
export const FlowRunGraph = (props: FlowRunGraphProps) =>
  props.childCards === undefined ? <RunGraphBody {...props} cards={NO_CARDS} />
    : <LiveFlowRunGraph {...props} collection={props.childCards} />

const RunGraphBody = ({
  card,
  view,
  onRunCommand,
  flowDurations = EMPTY_DURATIONS,
  fileCards = [],
  cards
}: FlowRunGraphProps & { readonly cards: ReadonlyArray<Card> }) => {
  const { runId, graph, repo } = card.payload
  const events = useMemo(() => graphEventsOf(card), [card])
  const visible = useMemo(() => events === card.payload.events ? card : { ...card, payload: { ...card.payload, events } }, [card, events])
  const forest = useMemo(() => runForestOf(card, cards, view, view.executionId, view.defaultExecutionId), [card, cards, view])
  const inputs = useMemo(() => runInputsOf(visible, cards), [visible, cards])
  const measured = useMemo(() => flowDurations.filter((row) => row.repo === repo && row.flowId === card.payload.workflow && row.workspaceId === card.payload.workspaceId), [flowDurations, repo, card.payload.workflow, card.payload.workspaceId])
  // The surface extends this last engine timestamp with a subscribed
  // monotonic clock while nodes run, even between journal pages.
  const observedAt = observedAtOf(events)
  const follow = graph?.follow !== false
  /*
   * The graph view exists only where the flow builder does (D-038), so the
   * drill-in beside it needs no second flag: the node this card has open and
   * the tab it shows are the card's own facts (state/controller/graph.ts).
   */
  const drill = {
    repo,
    /*
     * The revision the sites this canvas draws were read at, from whichever
     * source the canvas took its nodes from (`graphOf`): a site and the
     * revision it came from are one answer (D-068).
     */
    ...(view.sourceRevision === undefined ? {} : { sourceRevision: view.sourceRevision }),
    doors: { select: "runs.graph.select", tab: "runs.graph.tab", target: runId } as const,
    ...(graph?.node === undefined ? {} : { selected: graph.node }),
    ...(graph?.tab === undefined ? {} : { tab: graph.tab }),
    ...(graph?.codeError === undefined ? {} : { codeError: graph.codeError }),
    files: fileCards,
    onRunCommand
  }
  return (
    <>
      <div className="run-trace-bar" data-view="graph" role="group" aria-label="Trace presentation">
        <button
          type="button"
          className="run-trace-filter run-trace-view"
          aria-pressed={false}
          {...flowAction(onRunCommand, "runs.trace.view", flowArgs("runs.trace.view", { runId, view: "turns" }))}
        >
          Turns
        </button>
        <span className="run-trace-bar-title">Graph</span>
        <button
          type="button"
          className="run-trace-filter"
          data-on={follow}
          aria-pressed={follow}
          {...flowAction(onRunCommand, "runs.graph.follow", flowArgs("runs.graph.follow", { runId, follow: !follow }))}
        >
          Follow
        </button>
      </div>
      <Suspense fallback={<ViewSkeleton />}>
        <FlowRunGraphSurface
          nodes={forest.nodes}
          edges={forest.edges}
          status={view.status}
          focusId={follow ? view.focusId : undefined}
          durations={measured}
          frozenClock={card.payload.cursorSeq !== undefined}
          {...(observedAt === undefined ? {} : { observedAt })}
          {...(events === undefined ? {} : { records: events })}
          {...(view.executionId === undefined ? {} : { executionId: view.executionId })}
          {...(view.executionId === view.defaultExecutionId ? { inputs } : {})}
          drill={drill}
        />
      </Suspense>
    </>
  )
}
