/*
 * The plan, as a graph: the drawn half.
 *
 * Lazy on purpose (ViewModules.ts): `@xyflow/react` and `dagre` are the two
 * heaviest things this app can load, and a session that never opens a plan
 * must never pay for them. The shape is proved in FlowGraph.test.ts, which
 * runs without a canvas; this file is anatomy and nothing else.
 *
 * React Flow is UNCONTROLLED here — `fitView` and no `useReactFlow` — because
 * apps/app bans `useEffect` and the retired target-graph card proved the
 * camera does not need one for a graph that is drawn once.
 *
 * The drill-in rides beside the canvas rather than inside it: which node is
 * open is a fact on the card (state/controller/graph.ts), so a click, a key
 * and the agent all reach the same flow and the canvas holds no selection of
 * its own. A surface without `drill` — a static preview, or a card rendered
 * with the flow builder off — draws exactly the canvas it drew before.
 */
import "@xyflow/react/dist/style.css"
import { graphSelectArgs } from "../flows/FlowArgs"
import { payloadFor } from "../flows/SlashPayload"
import { Background, Handle, Position, ReactFlow, type NodeProps } from "@xyflow/react"
import { WorkflowCanvas, WorkflowNode, WorkflowNodeContent } from "@smthrs/ui"
import { memo, useMemo, useRef } from "react"
import { flowGraphModel, layoutFlowGraph, sitesByNode, type PlanCardGraph, type PlanCardNode } from "./FlowGraph"
import { displayByNode, type DurationDisplay } from "./flowGraph/Durations"
import { focusedNodeId, focusWalkedNode, nodeButton, type GraphCamera } from "./flowGraph/NodeAria"
import type { FlowDurationsRow } from "../state/AppState"
import {
  FlowGraphDrawer,
  FlowGraphTriggerDrawer,
  fileFor,
  graphKeyAct,
  planDrawerNode,
  type GraphDrill
} from "./FlowGraphDrawer"
import type { TriggerGraphPart } from "./FlowGraphTriggerNode"
import { describeSchedule } from "./TriggerEvents"

const FlowPlanNode = memo(({ data }: NodeProps) => {
  const { node, duration, selected } = data as unknown as {
    readonly node: PlanCardNode
    readonly duration?: DurationDisplay
    readonly selected?: boolean
  }
  return (
    <WorkflowNode
      title={node.action ?? node.id}
      kind={node.kind}
      className="flow-graph-node"
      data-node={node.id}
      data-tier={node.tier}
      data-status={node.status}
      {...(selected === undefined ? {} : { "data-selected": selected ? "true" : "false" })}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className="flow-graph-handle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="flow-graph-handle" />
      <WorkflowNodeContent className="flow-graph-node-foot">
        <span className="flow-graph-node-word">{node.status}</span>
        {/* The measured p50 for what this node dispatches. A node with no
            history wears nothing here (D-030, MINIMAL TEXT). */}
        {duration === undefined ? null : (
          <span className="flow-graph-node-eta" title={duration.detail}>{duration.text}</span>
        )}
      </WorkflowNodeContent>
    </WorkflowNode>
  )
})
FlowPlanNode.displayName = "FlowPlanNode"

/*
 * A schedule on the canvas (D-031): the sentence the dispatcher card reads
 * off the same row, and the one word the node is at. It has no tier, no key
 * and no settlement, so it wears none of them, and it is drawn with only a
 * source handle because nothing in the plan can wait on it.
 */
const FlowTriggerNode = memo(({ data }: NodeProps) => {
  const { trigger, selected } = data as unknown as {
    readonly trigger: NonNullable<TriggerGraphPart["nodes"][number]>
    readonly selected?: boolean
  }
  return (
    <WorkflowNode
      title={describeSchedule(trigger.row.cron, trigger.row.timezone)}
      className="flow-graph-node flow-graph-trigger-node"
      data-node={trigger.id}
      data-trigger-state={trigger.state}
      {...(selected === undefined ? {} : { "data-selected": selected ? "true" : "false" })}
    >
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="flow-graph-handle" />
      <WorkflowNodeContent className="flow-graph-node-foot">
        <span className="flow-graph-node-word">{trigger.state}</span>
      </WorkflowNodeContent>
    </WorkflowNode>
  )
})
FlowTriggerNode.displayName = "FlowTriggerNode"

const nodeTypes = { planNode: FlowPlanNode, triggerNode: FlowTriggerNode }

/** The plan's nodes and edges, drawn. An empty plan draws nothing at all. */
export const FlowGraphSurface = ({
  nodes,
  graph,
  durations = [],
  triggers,
  drill
}: {
  readonly nodes: ReadonlyArray<PlanCardNode>
  /** The labelled edges the workspace reported, and where it says each node was declared. */
  readonly graph?: PlanCardGraph | undefined
  /** This flow's measured history, from the `flowDurations` collection. */
  readonly durations?: ReadonlyArray<FlowDurationsRow>
  /** The schedules that fire this flow, drawn beside the plan and never counted in it. */
  readonly triggers?: TriggerGraphPart | undefined
  /** The drill-in: absent draws the canvas alone. */
  readonly drill?: GraphDrill | undefined
}) => {
  const measured = useMemo(() => displayByNode(nodes, durations), [nodes, durations])
  const laidOut = useMemo(
    () => layoutFlowGraph(flowGraphModel(nodes, graph, triggers), measured),
    [nodes, graph, triggers, measured]
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
  const camera = useRef<GraphCamera | undefined>(undefined)
  if (laidOut.nodes.length === 0) return null
  const node = nodes.find((candidate) => candidate.id === selected)
  const site = node === undefined ? undefined : sitesByNode(graph).get(node.id)
  const trigger = (triggers?.nodes ?? []).find((candidate) => candidate.id === selected)
  const onKeyDown = drill === undefined ? undefined : (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const focused = focusedNodeId(event.target)
    const act = graphKeyAct(event.key, {
      ids: laidOut.nodes.map((drawnNode) => drawnNode.id),
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
      focusWalkedNode(event.currentTarget, parsed.payload.nodeId, camera.current)
    }
  }
  return (
    <>
      <WorkflowCanvas
        className="flow-plan-canvas"
        role={drill === undefined ? "region" : "group"}
        aria-label="Plan graph"
        {...(onKeyDown === undefined ? {} : { onKeyDown })}
      >
        <ReactFlow
          nodes={[...drawn]}
          edges={[...laidOut.edges]}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, minZoom: 1, maxZoom: 1, nodes: [{ id: selected ?? nodes.find(node => node.dependsOn.length === 0)?.id ?? laidOut.nodes[0]!.id }] }}
          minZoom={1}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable
          onInit={(instance) => { camera.current = instance }}
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
      {drill === undefined || node === undefined ? null : (
        <FlowGraphDrawer
          node={planDrawerNode(node, site, drill.previousNodes)}
          tab={drill.tab}
          doors={drill.doors}
          {...(measured.get(node.id) === undefined ? {} : { duration: measured.get(node.id) })}
          {...(drill.sourceRevision === undefined ? {} : { sourceRevision: drill.sourceRevision })}
          {...(fileFor(drill.files, drill.repo, site, drill.sourceRevision) === undefined
            ? {}
            : { file: fileFor(drill.files, drill.repo, site, drill.sourceRevision) })}
          {...(drill.codeError === undefined ? {} : { codeError: drill.codeError })}
          onRunCommand={drill.onRunCommand}
        />
      )}
      {drill === undefined || trigger === undefined ? null : (
        <FlowGraphTriggerDrawer trigger={trigger} repo={drill.repo} doors={drill.doors} onRunCommand={drill.onRunCommand} />
      )}
    </>
  )
}
