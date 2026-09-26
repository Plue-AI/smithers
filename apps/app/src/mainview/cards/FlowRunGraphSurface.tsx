/*
 * The run's graph: the drawn half.
 *
 * Lazy on purpose (ViewModules.ts): `@xyflow/react` and `dagre` are the two
 * heaviest things this app can load, and a session that never opens a run's
 * graph must never pay for them. The shape and the states are proved in
 * FlowGraphStatus.test.ts and in the layout test beside this file, which run
 * without a canvas; this file is anatomy and a camera.
 *
 * React Flow is UNCONTROLLED here, as FlowGraphSurface.tsx set the precedent:
 * `fitView` and no `useReactFlow`, because apps/app bans `useEffect`. Follow
 * is the same trick — the canvas is keyed by the node it is watching, so a new
 * running node mounts a canvas that fits itself onto that node. Nothing here
 * holds state: what the camera is doing lives in the card payload.
 */
import "@xyflow/react/dist/style.css"
import { graphSelectArgs } from "../flows/FlowArgs"
import { payloadFor } from "../flows/SlashPayload"
import { Background, Handle, Position, ReactFlow, type NodeProps } from "@xyflow/react"
import { WorkflowCanvas, WorkflowNode, WorkflowNodeContent } from "@smthrs/ui"
import dagre from "dagre"
import { memo, useMemo, type CSSProperties } from "react"
import { useObservedClock } from "@smthrs/ui/clock"
import { NODE_HEIGHT, NODE_WIDTH } from "./FlowGraph"
import { displayByNode, progressOf, type DurationDisplay } from "./flowGraph/Durations"
import { focusedNodeId, graphNodeLabel, nodeButton } from "./flowGraph/NodeAria"
import { durationWords, type JournalRecord } from "./RunTrace"
import type { FlowDurationsRow } from "../state/AppState"
import { FlowGraphDrawer, fileFor, graphKeyAct, runDrawerNode, type GraphDrill } from "./FlowGraphDrawer"
import { stateWord, type NodeRun, type RunGraphEdge, type RunGraphNode } from "./FlowGraphStatus"

/* The word lives with the fold it reads (FlowGraphStatus.ts); the canvas and the drawer print the same one. */
export { stateWord }

/** Compact ranks keep nearby work visible at readable zoom (D-034). */
const RANK_SEP = 24
const NODE_SEP = 16
const EMPTY_DURATIONS: ReadonlyArray<FlowDurationsRow> = []

/*
 * One class per edge reason, written out. A template would name no class any
 * source file contains, and DeadCss.test.ts would read every rule below as a
 * rule for markup that no longer exists.
 *
 * An edge whose source stated no reason wears the base class alone: there is
 * no class for a reason nobody gave.
 */
const EDGE_CLASS = {
  value: "flow-graph-edge flow-graph-edge-value",
  continuation: "flow-graph-edge flow-graph-edge-continuation",
  failure: "flow-graph-edge flow-graph-edge-failure",
  conflict: "flow-graph-edge flow-graph-edge-conflict",
  "lane-merge": "flow-graph-edge flow-graph-edge-lane-merge"
} as const

/** How long a settled node really took, when its records timed both ends. */
const settledDuration = (run: NodeRun | undefined): number | undefined =>
  run?.status !== "settled" || run.startedAt === undefined || run.settledAt === undefined
    ? undefined
    : Math.max(0, run.settledAt - run.startedAt)

/** One positioned node, in the shape React Flow's `nodes` prop takes. */
export interface RunGraphLayoutNode {
  readonly id: string
  readonly type: "runNode"
  readonly position: { readonly x: number; readonly y: number }
  readonly data: {
    readonly node: RunGraphNode
    readonly run: NodeRun | undefined
    /** What this node's action tag has measured, when anything has. */
    readonly duration?: DurationDisplay
    /** How long a running node has been running, by the engine's own clock. */
    readonly elapsedMs?: number
    readonly [key: string]: unknown
  }
  readonly width: number
  readonly height: number
  readonly draggable: false
  readonly connectable: false
  readonly deletable: false
  readonly ariaLabel: string
}

/** One positioned edge, in the shape React Flow's `edges` prop takes. */
export interface RunGraphLayoutEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly type: "smoothstep"
  readonly className: string
  readonly data: { readonly reason: RunGraphEdge["reason"] }
}

export interface RunGraphLayout {
  readonly nodes: ReadonlyArray<RunGraphLayoutNode>
  readonly edges: ReadonlyArray<RunGraphLayoutEdge>
}

/**
 * The run's graph laid out, top to bottom.
 *
 * Positions are rounded to whole pixels so the same graph lays out to the same
 * bytes twice: a canvas that moved by a floating-point hair on every poll
 * would re-render on every poll. An edge naming a node this graph does not
 * carry is dropped, because a half-drawn edge is a lie about the graph and a
 * throw would take the whole card down over one bad id.
 */
const layoutTopology = (
  nodes: ReadonlyArray<RunGraphNode>, edges: ReadonlyArray<RunGraphEdge>
) => {
  const known = new Set(nodes.map((node) => node.id))
  const seen = new Set<string>()
  const drawn: Array<RunGraphEdge & { readonly id: string }> = []
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue
    const id = `${edge.from}->${edge.to}`
    if (seen.has(id)) continue
    seen.add(id)
    drawn.push({ ...edge, id })
  }

  const layout = new dagre.graphlib.Graph()
  layout.setDefaultEdgeLabel(() => ({}))
  layout.setGraph({ rankdir: "TB", ranker: "longest-path", ranksep: RANK_SEP, nodesep: NODE_SEP, marginx: 24, marginy: 24 })
  for (const node of nodes) layout.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of drawn) layout.setEdge(edge.from, edge.to)
  dagre.layout(layout)

  return {
    positions: new Map(nodes.map(node => {
      const positioned = layout.node(node.id)
      return [node.id, { x: Math.round((positioned?.x ?? 0) - NODE_WIDTH / 2), y: Math.round((positioned?.y ?? 0) - NODE_HEIGHT / 2) }] as const
    })),
    edges: drawn.map((edge): RunGraphLayoutEdge => ({
      id: edge.id, source: edge.from, target: edge.to, type: "smoothstep",
      className: edge.reason === undefined ? "flow-graph-edge" : EDGE_CLASS[edge.reason], data: { reason: edge.reason }
    }))
  }
}

const decorateGraph = (
  topology: ReturnType<typeof layoutTopology>,
  nodes: ReadonlyArray<RunGraphNode>, status: ReadonlyMap<string, NodeRun>,
  durations?: ReadonlyMap<string, DurationDisplay>, observedAt?: number
): RunGraphLayout => ({
    nodes: nodes.map((node): RunGraphLayoutNode => {
      const run = status.get(node.id)
      /*
       * The prediction reaches only a node that has yet to run. A node that
       * settled states what it really took, and one whose records time only
       * one end — a `skipped` node was never scheduled, so it has no start —
       * states nothing at all rather than wearing a cost it never paid
       * (D-032). An `unproven` node is a node whose history has a hole, and a
       * prediction beside it would read as a node still to come.
       */
      const predicted = run === undefined || run.status === "pending" || run.status === "running"
        ? durations?.get(node.id)
        : undefined
      return {
        id: node.id,
        type: "runNode",
        position: topology.positions.get(node.id)!,
        data: {
          node,
          run,
          ...(predicted === undefined ? {} : { duration: predicted }),
          ...(run?.status !== "running" || run.startedAt === undefined || observedAt === undefined
            ? {}
            : { elapsedMs: Math.max(0, observedAt - run.startedAt) })
        },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        draggable: false,
        connectable: false,
        deletable: false,
        ariaLabel: graphNodeLabel(node.action, node.id, stateWord(run))
      }
    }),
    edges: topology.edges
})

/** Pure layout entry point for callers that need a complete one-shot projection. */
export const layoutRunGraph = (
  nodes: ReadonlyArray<RunGraphNode>, edges: ReadonlyArray<RunGraphEdge>, status: ReadonlyMap<string, NodeRun>,
  durations?: ReadonlyMap<string, DurationDisplay>, observedAt?: number
): RunGraphLayout => decorateGraph(layoutTopology(nodes, edges), nodes, status, durations, observedAt)


/**
 * One node: the action tag it dispatches, its plan node id beneath, and the
 * word for what happened to it (D-040, D-026).
 *
 * A node the engine scheduled more than once wears the attempt number, and a
 * node with no records at all wears `pending` rather than nothing: silence is
 * a state too.
 */
const FlowRunNode = memo(({ data }: NodeProps) => {
  const { node, run, duration, elapsedMs, selected } = data as unknown as {
    readonly node: RunGraphNode
    readonly run: NodeRun | undefined
    readonly duration?: DurationDisplay
    readonly elapsedMs?: number
    readonly selected?: boolean
  }
  const word = stateWord(run)
  /*
   * What this node took, or what its history says it takes. A settled node
   * has both its own timestamps, so it states the measurement; anything else
   * states the prediction, and a node with neither states nothing at all.
   */
  const took = settledDuration(run)
  /*
   * A running node against its own p50: the bar fills with what has elapsed,
   * and once the run passes the p90 the prediction has been overtaken, so
   * the node shows the elapsed time alone rather than a bar pinned full.
   */
  const fill = elapsedMs === undefined ? undefined : progressOf(elapsedMs, duration)
  const overtaken = elapsedMs !== undefined && duration !== undefined && fill === undefined
  const time = took !== undefined
    ? durationWords(took)
    : overtaken
    ? durationWords(elapsedMs)
    : fill !== undefined && duration !== undefined
    ? `of ${duration.text}`
    : duration?.text ?? (elapsedMs === undefined ? undefined : durationWords(elapsedMs))
  return (
    <WorkflowNode
      title={node.action ?? node.id}
      kind={node.kind}
      className="flow-graph-node"
      data-node={node.id}
      data-tier={node.tier}
      data-state={word}
      {...(selected === undefined ? {} : { "data-selected": selected ? "true" : "false" })}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className="flow-graph-handle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="flow-graph-handle" />
      <WorkflowNodeContent className="flow-graph-node-foot">
        <span className="flow-run-node-id">{node.id}</span>
        {run !== undefined && run.attempts > 1 ? <span className="flow-run-node-attempt">attempt {run.attempts}</span> : null}
        <span className="flow-graph-node-word" data-state={word}>{word}</span>
        {time === undefined ? null : (
          <span className="flow-graph-node-eta" title={took === undefined ? duration?.detail : undefined}>{time}</span>
        )}
        {fill === undefined ? null : (
          <span
            className="flow-run-node-bar"
            style={{ "--flow-run-fill": fill } as CSSProperties}
            aria-hidden="true"
          />
        )}
      </WorkflowNodeContent>
    </WorkflowNode>
  )
})
FlowRunNode.displayName = "FlowRunNode"

const nodeTypes = { runNode: FlowRunNode }

/** The run's nodes and edges, drawn. A graph with no nodes draws nothing at all. */
export const FlowRunGraphSurface = ({
  nodes,
  edges,
  status,
  focusId,
  durations = EMPTY_DURATIONS,
  observedAt,
  records,
  executionId,
  drill
}: {
  readonly nodes: ReadonlyArray<RunGraphNode>
  readonly edges: ReadonlyArray<RunGraphEdge>
  readonly status: ReadonlyMap<string, NodeRun>
  /** The node the camera is watching; absent preserves the reader's camera after initially framing the entry node. */
  readonly focusId?: string | undefined
  /** This flow's measured history, from the `flowDurations` collection. */
  readonly durations?: ReadonlyArray<FlowDurationsRow>
  /** The newest moment the engine emitted a row this card read; a running node measures against it. */
  readonly observedAt?: number | undefined
  /** The run's journal, which the open node's Events and Code read. */
  readonly records?: ReadonlyArray<JournalRecord> | undefined
  /** The execution these nodes were recorded under, so the journal read is that execution's. */
  readonly executionId?: string | undefined
  /** The drill-in: absent draws the canvas alone. */
  readonly drill?: GraphDrill | undefined
}) => {
  const measured = useMemo(() => displayByNode(nodes, durations), [nodes, durations])
  // Journal folds allocate fresh arrays. Geometry depends on these scalar
  // topology facts, not allocation identity, measurements, status or clock.
  const topologyKey = JSON.stringify([nodes.map(node => node.id), edges])
  const topology = useMemo(() => layoutTopology(nodes, edges), [topologyKey])
  const running = [...status.values()].some(run => run.status === "running")
  const clock = useObservedClock(observedAt, running)
  const laidOut = useMemo(
    () => decorateGraph(topology, nodes, status, measured, clock),
    [topology, nodes, status, measured, clock]
  )
  const selected = drill?.selected
  const drawn = useMemo(
    () => laidOut.nodes.map((node) => ({
      ...node,
      ...(drill === undefined ? {} : {
        domAttributes: nodeButton(node.id === selected),
        data: { ...node.data, selected: node.id === selected }
      })
    })),
    [laidOut, drill, selected]
  )
  if (laidOut.nodes.length === 0) return null
  const open = nodes.find((candidate) => candidate.id === selected)
  const onKeyDown = drill === undefined ? undefined : (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const focused = focusedNodeId(event.target)
    const act = graphKeyAct(event.key, {
      ids: laidOut.nodes.map((node) => node.id),
      edges: laidOut.edges.map((edge) => ({ from: edge.source, to: edge.target })),
      selected,
      ...(focused === undefined ? {} : { focused }),
      doors: drill.doors
    })
    if (act === undefined) return
    event.preventDefault()
    drill.onRunCommand(act.flow, act.args)
    const parsed = payloadFor(act.flow, act.args)
    if ("payload" in parsed && typeof parsed.payload.nodeId === "string") {
      const wrapper = [...event.currentTarget.querySelectorAll<HTMLElement>(".react-flow__node")]
        .find(element => element.dataset.id === parsed.payload.nodeId)
      wrapper?.focus({ preventScroll: true })
    }
  }
  return (
    <>
    <WorkflowCanvas
      className="flow-plan-canvas"
      role={drill === undefined ? "region" : "group"}
      aria-label="Run graph"
      {...(onKeyDown === undefined ? {} : { onKeyDown })}
    >
      <ReactFlow
        /*
         * The camera, without an effect. `fitView` runs when React Flow
         * mounts, so keying the canvas by the node it is watching is what
         * moves it: a new running node mounts a canvas already framed on that
         * node. With no focus the key never changes, and a reader's own pan
         * and zoom survive every poll.
         */
        key={focusId ?? "whole"}
        nodes={[...drawn]}
        edges={[...laidOut.edges]}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3, minZoom: 1, maxZoom: 1,
          nodes: [{ id: focusId ?? selected ?? nodes.find(node => node.dependsOn.length === 0)?.id ?? nodes[0]!.id }] }}
        minZoom={1}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        {...(drill === undefined ? {} : {
          onNodeClick: (_event: unknown, clicked: { readonly id: string }) =>
            drill.onRunCommand(drill.doors.select, graphSelectArgs(drill.doors, clicked.id))
        })}
      >
        <Background gap={26} />
      </ReactFlow>
    </WorkflowCanvas>
    {drill === undefined || open === undefined ? null : (
      <FlowGraphDrawer
        node={runDrawerNode(open, status.get(open.id), executionId)}
        tab={drill.tab}
        doors={drill.doors}
        {...(measured.get(open.id) === undefined ? {} : { duration: measured.get(open.id) })}
        {...(drill.sourceRevision === undefined ? {} : { sourceRevision: drill.sourceRevision })}
        {...(fileFor(drill.files, drill.repo, open.declaredAt, drill.sourceRevision) === undefined
          ? {}
          : { file: fileFor(drill.files, drill.repo, open.declaredAt, drill.sourceRevision) })}
        {...(drill.codeError === undefined ? {} : { codeError: drill.codeError })}
        {...(records === undefined ? {} : { records })}
        onRunCommand={drill.onRunCommand}
      />
    )}
    </>
  )
}
