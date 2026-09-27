/**
 * Target graphs, run summaries, and traversal utilities.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/*
 * The target-graph contract between the local app's Bun backend
 * (`apps/app/src/bun`) and the chat UI (`apps/app/src/mainview`). It is the
 * product's API, not the CLI's: the backend maps `smithers-build graph --format json`,
 * `smithers-build <label> --plan --format json`, and a streamed `smithers-build <label>` run
 * onto these shapes; the UI renders only these shapes.
 *
 * Everything a Bazel / Nx / Turborepo / Temporal operator expects to see is
 * expressed here once: the typed dependency DAG, per-node plan facts (rule,
 * key, cacheability, refusal, argv, sandbox), live per-node run status with
 * timings and cache hits, the run's critical path, run history for replay,
 * the diff-affected set, and the generated CI matrix.
 */

/** Edge kinds the loader classifies (`Concepts`: three edge kinds plus plain deps).
 * @since 1.0.0
 * @category constants
 */
export const GRAPH_EDGE_KINDS = ["data", "gates", "services", "deps"] as const
/**
 * Validates graph edge kind values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const GraphEdgeKindSchema = z.enum(GRAPH_EDGE_KINDS)
/**
 * The decoded value accepted by {@link GraphEdgeKindSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type GraphEdgeKind = z.infer<typeof GraphEdgeKindSchema>

/** One node of the target graph: the loader row plus the plan facts the backend could resolve.
 * @since 1.0.0
 * @category schemas
 */
export const GraphNodeSchema = z.object({
  /** Canonical label, `//pkg/path:name`. */
  label: z.string(),
  package: z.string(),
  name: z.string(),
  /** Rule name as the loader prints it: `Shell.Test`, `Agent.Lint`, `Go.Binary`, ... */
  rule: z.string(),
  /** Flavor kinds (`build`, `test`, `lint`, `run`, `docs`); empty for pure data. */
  kinds: z.array(z.string()),
  /** Private (unlabeled) helper node reachable through an edge, e.g. `//src:__private_Overlay_4`. */
  private: z.boolean().default(false),
  /** Present when the backend planned the node (`--plan`). */
  plan: z
    .object({
      mode: z.enum(["execute", "check", "write"]).optional(),
      cacheable: z.boolean().optional(),
      /** The node's cache key as the planner prints it (64 hex chars, or a shorter preview); never a secret. */
      key: z.string().optional(),
      /** Typed refusal at plan time (host bin absent, approval required, missing input, NotImplemented). */
      refusal: z.string().optional(),
      argv: z.array(z.string()).optional(),
      sandbox: z.string().optional(),
      outDirs: z.array(z.string()).optional(),
      outFiles: z.array(z.string()).optional(),
      /** Input paths/globs when the CLI exposes them; used by affected analysis. */
      inputs: z.array(z.string()).optional()
    })
    .optional(),
  /** Declaration site for "open in editor". */
  source: z.object({ file: z.string(), line: z.number().optional() }).optional()
})
/**
 * The decoded value accepted by {@link GraphNodeSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type GraphNode = z.infer<typeof GraphNodeSchema>

/**
 * Validates graph edge values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: GraphEdgeKindSchema
})
/**
 * The decoded value accepted by {@link GraphEdgeSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type GraphEdge = z.infer<typeof GraphEdgeSchema>

/** `POST /api/targets/graph` `{ repoId, plan?: boolean, labels?: string[] }`
 * @since 1.0.0
 * @category schemas
 */
export const TargetGraphResponseSchema = z.object({
  repoId: z.string(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  warnings: z.array(z.string()),
  /** ISO timestamp of the load; the UI shows staleness. */
  generatedAt: z.string(),
  /**
   * Digest of the declaration set the graph was loaded from (every
   * PACKAGE.ts/WORKSPACE.ts path + content hash). A card compares it to
   * decide whether a cached graph is stale after an edit.
   */
  digest: z.string().optional(),
  durationMs: z.number()
})
/**
 * The decoded value accepted by {@link TargetGraphResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetGraphResponse = z.infer<typeof TargetGraphResponseSchema>

/** Per-node run status as the executor reports it.
 * @since 1.0.0
 * @category constants
 */
export const NODE_RUN_STATUSES = [
  "pending",
  "running",
  "hit",
  "ran",
  "failed",
  "skipped",
  "refused",
  "cancelled"
] as const
/**
 * Validates node run status values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const NodeRunStatusSchema = z.enum(NODE_RUN_STATUSES)
/**
 * The decoded value accepted by {@link NodeRunStatusSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type NodeRunStatus = z.infer<typeof NodeRunStatusSchema>

/** One node's timing row in a run (the Gantt row).
 * @since 1.0.0
 * @category schemas
 */
export const NodeTimingSchema = z.object({
  label: z.string(),
  status: NodeRunStatusSchema,
  /** Epoch ms; absent until the node starts / settles. */
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /**
   * Wall time of the node. The backend always sets it when it knows the
   * node settled (`hit` rows are 0 or the executor's reported time) and it
   * equals `endedAt - startedAt` whenever both timestamps are present;
   * `criticalPath` reads only this field.
   */
  durationMs: z.number().optional(),
  key: z.string().optional(),
  /** Refusal or failure text, first line. */
  reason: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  /** The target's rule (`Vitest`, `EsLint`), from the executor's results block when it prints one. */
  rule: z.string().optional()
})
/**
 * The decoded value accepted by {@link NodeTimingSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type NodeTiming = z.infer<typeof NodeTimingSchema>

/** Run-level summary the executor prints at the end (`N targets: a hit, b ran, c failed, d skipped`).
 * @since 1.0.0
 * @category schemas
 */
export const RunSummarySchema = z.object({
  total: z.number(),
  hit: z.number(),
  ran: z.number(),
  failed: z.number(),
  skipped: z.number(),
  durationMs: z.number(),
  ok: z.boolean(),
  /** Labels on the longest dependency chain by wall time, root last. */
  criticalPath: z.array(z.string())
})
/**
 * The decoded value accepted by {@link RunSummarySchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RunSummary = z.infer<typeof RunSummarySchema>

/**
 * Frames on the WS topic `target-run:<runId>`. The first three are the
 * existing stdout/stderr/exit/error frames; `node` and `summary` are the
 * structured ones the graph overlay and the timeline consume. `stdout` and
 * `stderr` frames carry `label` when the backend can attribute the chunk.
 */
/**
 * `seq` is the run-local monotonic frame number the backend assigns to every
 * frame it observes (0-based). Retained output may have gaps after the
 * explicit journal-cap marker. Replay orders by `seq`, never by
 * `at`, so two frames in one millisecond stay ordered; it is optional only
 * for frames produced before the backend recorded them.
 */
const frameSeq = { seq: z.number().int().nonnegative().optional() }

/**
 * Validates target run event values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TargetRunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdout"), data: z.string(), label: z.string().optional(), ...frameSeq }),
  z.object({ type: z.literal("stderr"), data: z.string(), label: z.string().optional(), ...frameSeq }),
  // New writers record terminal time in the fact; legacy journals may only
  // carry it on their final RunRecord.
  z.object({ type: z.literal("exit"), code: z.number().nullable(), at: z.number().optional(), ...frameSeq }),
  z.object({ type: z.literal("error"), message: z.string(), ...frameSeq }),
  z.object({
    type: z.literal("started"),
    runId: z.string(),
    label: z.string(),
    at: z.number(),
    labels: z.array(z.string()),
    ...frameSeq
  }),
  z.object({ type: z.literal("node"), node: NodeTimingSchema, at: z.number(), ...frameSeq }),
  z.object({ type: z.literal("summary"), summary: RunSummarySchema, at: z.number(), ...frameSeq })
])
/**
 * The decoded value accepted by {@link TargetRunEventSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetRunEvent = z.infer<typeof TargetRunEventSchema>

/** One recorded run, for history and replay.
 * @since 1.0.0
 * @category schemas
 */
export const RunRecordSchema = z.object({
  runId: z.string(),
  repoId: z.string(),
  /** The root label(s) the user ran. */
  label: z.string(),
  labels: z.array(z.string()).default([]),
  status: z.enum(["pending", "running", "done", "failed", "cancelled"]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  summary: RunSummarySchema.optional(),
  /** Absent when no loss is known. A degraded replay contains only acknowledged frames. */
  journal: z.object({ state: z.literal("degraded"), error: z.string() }).optional()
})
/**
 * The decoded value accepted by {@link RunRecordSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RunRecord = z.infer<typeof RunRecordSchema>

/** `POST /api/targets/runs` `{ repoId }`
 * @since 1.0.0
 * @category schemas
 */
export const RunHistoryResponseSchema = z.object({ runs: z.array(RunRecordSchema) })
/**
 * The decoded value accepted by {@link RunHistoryResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RunHistoryResponse = z.infer<typeof RunHistoryResponseSchema>

/** `POST /api/targets/runs/replay` `{ runId }` — every recorded frame in order, for the scrubber.
 * @since 1.0.0
 * @category schemas
 */
export const RunReplayResponseSchema = z.object({
  run: RunRecordSchema,
  events: z.array(TargetRunEventSchema)
})
/**
 * The decoded value accepted by {@link RunReplayResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RunReplayResponse = z.infer<typeof RunReplayResponseSchema>

/** `POST /api/targets/affected` `{ repoId }` — what the working-tree diff re-keys.
 * @since 1.0.0
 * @category schemas
 */
export const AffectedResponseSchema = z.object({
  repoId: z.string(),
  base: z.string(),
  changedFiles: z.array(z.string()),
  affected: z.array(
    z.object({
      label: z.string(),
      /** Why: the changed input(s) that reach the node, or "transitive via <label>". */
      reason: z.string()
    })
  ),
  /** Signals used by this conservative local approximation. */
  signal: z.string().optional(),
  /** Known blind spots in the available CLI/declaration information. */
  limits: z.array(z.string()).optional(),
  durationMs: z.number()
})
/**
 * The decoded value accepted by {@link AffectedResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AffectedResponse = z.infer<typeof AffectedResponseSchema>

/** `POST /api/targets/ci` `{ repoId }` — the generated GitHub matrix, as the graph implies it.
 * @since 1.0.0
 * @category schemas
 */
export const CiMatrixResponseSchema = z.object({
  repoId: z.string(),
  workflows: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      yaml: z.string(),
      /** Scratch-rendered when possible; on-disk is an explicit fallback. */
      source: z.enum(["scratch-render", "on-disk"]).optional(),
      jobs: z.array(
        z.object({
          name: z.string(),
          targets: z.array(z.string()),
          /** Shard fan-out or other matrix axes. */
          matrix: z.record(z.string(), z.array(z.string())).optional()
        })
      )
    })
  ),
  warnings: z.array(z.string()).optional(),
  durationMs: z.number()
})
/**
 * The decoded value accepted by {@link CiMatrixResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CiMatrixResponse = z.infer<typeof CiMatrixResponseSchema>

/*
 * Card payloads (the chat surface). Cards.ts adds one `kind` per payload:
 * `graph`, `run-timeline`, `run-history`, `affected`, `ci-matrix`.
 */
/**
 * Validates graph card payload values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const GraphCardPayloadSchema = z.object({
  repoId: z.string(),
  repoName: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  graph: TargetGraphResponseSchema.optional(),
  error: z.string().optional(),
  /** Focused label: the UI highlights deps()/rdeps() and opens the detail drawer. */
  focus: z.string().optional(),
  /*
   * The canvas' own filter, in the payload for the same reason the targets
   * table keeps its view there: the card stays a projection, so the filter
   * survives a reload and an open-in-tab.
   */
  view: z.object({
    /** Substring match on the node label; absent = every node. */
    query: z.string().optional(),
    /** Private helpers drawn; absent = they stay collapsed. */
    showPrivate: z.boolean().optional()
  }).optional(),
  /** When set, the DAG overlays this run's node statuses. */
  runId: z.string().optional(),
  /*
   * The overlay's live state (additive, ui/ui lane): per-node timings as
   * `node` frames arrive, and the run's summary once it lands. Absent until
   * the first frame; replay (the history scrubber) fills it the same way.
   */
  run: z.object({ nodes: z.array(NodeTimingSchema), summary: RunSummarySchema.optional() }).optional()
})
/**
 * The decoded value accepted by {@link GraphCardPayloadSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type GraphCardPayload = z.infer<typeof GraphCardPayloadSchema>

/**
 * Validates run timeline card payload values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RunTimelineCardPayloadSchema = z.object({
  repoId: z.string(),
  runId: z.string(),
  label: z.string(),
  status: RunRecordSchema.shape.status,
  nodes: z.array(NodeTimingSchema),
  summary: RunSummarySchema.optional(),
  /** Replay position (epoch ms) when scrubbing a recorded run; absent = live. */
  cursor: z.number().optional(),
  /** The full run's time extent (additive, ui/ui lane): the scrubber's range, stable across cursors. */
  extent: z.object({ start: z.number(), end: z.number() }).optional(),
  /* Per-node stdout/stderr text from attributed frames (additive, ui/ui lane). */
  logs: z.record(z.string(), z.string()).optional(),
  /** Stream/process failure text; a failed card renders this verbatim. */
  error: z.string().optional()
})
/**
 * The decoded value accepted by {@link RunTimelineCardPayloadSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RunTimelineCardPayload = z.infer<typeof RunTimelineCardPayloadSchema>

/**
 * Validates run history card payload values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RunHistoryCardPayloadSchema = z.object({
  repoId: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  runs: z.array(RunRecordSchema),
  selected: z.string().optional(),
  error: z.string().optional()
})
/**
 * The decoded value accepted by {@link RunHistoryCardPayloadSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RunHistoryCardPayload = z.infer<typeof RunHistoryCardPayloadSchema>

/**
 * Validates affected card payload values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AffectedCardPayloadSchema = z.object({
  repoId: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  result: AffectedResponseSchema.optional(),
  error: z.string().optional()
})
/**
 * The decoded value accepted by {@link AffectedCardPayloadSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AffectedCardPayload = z.infer<typeof AffectedCardPayloadSchema>

/**
 * Validates ci matrix card payload values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CiMatrixCardPayloadSchema = z.object({
  repoId: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  result: CiMatrixResponseSchema.optional(),
  error: z.string().optional()
})
/**
 * The decoded value accepted by {@link CiMatrixCardPayloadSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CiMatrixCardPayload = z.infer<typeof CiMatrixCardPayloadSchema>

/**
 * Labels reachable from `label` along the given direction (deps = outgoing,
 * rdeps = incoming). The start label is not in the set unless a cycle
 * returns to it; an unknown label and a leaf both yield the empty set, so
 * a caller that must tell them apart checks `nodes` first.
 * @since 1.0.0
 * @category conversions
 */
export const reachable = (
  edges: ReadonlyArray<GraphEdge>,
  label: string,
  direction: "deps" | "rdeps"
): ReadonlySet<string> => {
  const next = new Map<string, Array<string>>()
  for (const edge of edges) {
    const [key, value] = direction === "deps" ? [edge.from, edge.to] : [edge.to, edge.from]
    const list = next.get(key)
    if (list === undefined) next.set(key, [value])
    else list.push(value)
  }
  const seen = new Set<string>()
  const stack = [label]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const neighbour of next.get(current) ?? []) {
      if (!seen.has(neighbour)) {
        seen.add(neighbour)
        stack.push(neighbour)
      }
    }
  }
  return seen
}

/**
 * The critical path of a settled run: the dependency chain whose summed
 * node durations is longest, root last. Nodes without timings count as 0.
 * Pure, so the backend computes it for `summary` and the UI can recompute
 * it for a replay cursor.
 * @since 1.0.0
 * @category conversions
 */
export const criticalPath = (
  nodes: ReadonlyArray<NodeTiming>,
  edges: ReadonlyArray<GraphEdge>
): ReadonlyArray<string> => {
  const duration = new Map<string, number>()
  for (const node of nodes) duration.set(node.label, node.durationMs ?? 0)
  const deps = new Map<string, Array<string>>()
  for (const edge of edges) {
    if (!duration.has(edge.from) || !duration.has(edge.to)) continue
    const list = deps.get(edge.from)
    if (list === undefined) deps.set(edge.from, [edge.to])
    else list.push(edge.to)
  }
  const best = new Map<string, { total: number; via: string | undefined }>()
  const visiting = new Set<string>()
  /*
   * Iterative post-order walk: recursion over graph depth overflows the call
   * stack on monorepo-scale chains (~50k frames). Each frame mirrors one
   * recursive call: deps are consumed in declaration order, a dep already in
   * `visiting` contributes 0 (cycle truncation) and is never memoized as such.
   */
  const solve = (rootLabel: string): void => {
    if (best.has(rootLabel)) return
    visiting.add(rootLabel)
    const frames: Array<
      { label: string; deps: Array<string>; index: number; longest: number; via: string | undefined }
    > = [
      { label: rootLabel, deps: deps.get(rootLabel) ?? [], index: 0, longest: 0, via: undefined }
    ]
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!
      if (frame.index < frame.deps.length) {
        const dep = frame.deps[frame.index]!
        const known = best.get(dep)
        if (known === undefined && !visiting.has(dep)) {
          visiting.add(dep)
          frames.push({ label: dep, deps: deps.get(dep) ?? [], index: 0, longest: 0, via: undefined })
          continue
        }
        // A dep still in `visiting` is a back edge: it contributes 0 and can
        // never be `via`, or the path walk below would loop through the cycle.
        if (
          known !== undefined &&
          (known.total > frame.longest || (frame.via === undefined && known.total === frame.longest))
        ) {
          frame.longest = known.total
          frame.via = dep
        }
        frame.index += 1
      } else {
        frames.pop()
        visiting.delete(frame.label)
        best.set(frame.label, { total: frame.longest + (duration.get(frame.label) ?? 0), via: frame.via })
      }
    }
  }
  /*
   * The root is the node with the longest total. Totals tie whenever a
   * consumer adds no wall time of its own (an all-hit run), so a tie goes to
   * the node nothing in the run depends on: the target that was asked for,
   * which is where a Bazel-style critical path ends.
   */
  const dependedOn = new Set<string>()
  for (const [from, list] of deps) if (duration.has(from)) { for (const to of list) dependedOn.add(to) }
  let root: string | undefined
  let rootTotal = -1
  for (const node of nodes) {
    solve(node.label)
    const total = best.get(node.label)!.total
    const winsTie = total === rootTotal && root !== undefined && dependedOn.has(root) && !dependedOn.has(node.label)
    if (total > rootTotal || winsTie) {
      rootTotal = total
      root = node.label
    }
  }
  const path: Array<string> = []
  const seen = new Set<string>()
  let cursor = root
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    path.push(cursor)
    cursor = best.get(cursor)?.via
  }
  return path.reverse()
}
