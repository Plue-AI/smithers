/*
 * One node of a graph, opened.
 *
 * Both graph cards drill into a node the same way, so this is one component
 * over one shape: a plan card's node (the control plane's keyed node, cut to
 * what a card carries) and a run's node (the graph the engine recorded, with
 * the state its records reached) reduce to `DrawerNode`, and the doors say
 * which card the acts address. Which node is open and which tab it shows are
 * facts on the card (state/controller/graph.ts); nothing here is component
 * state, so a poll, a reload and a restore all draw the same drawer.
 *
 * A tab with nothing behind it is ABSENT, never empty (D-035), and nothing is
 * completed into a value the engine never stated: the Code tab exists only
 * where a declaration site was recorded (D-037, D-047, D-054), Output only
 * where the settlement carried a result, Events only where the node has
 * records of its own, and Attempts only where the node's own record states
 * the step key digests it dispatched under (D-052). A box older than any of
 * those writes none of them, and the tab is simply not there.
 *
 * The journal is read here with the same narrowing RunTrace.ts uses rather
 * than a schema: a record this drawer cannot read is a record it does not
 * draw, never a hole in a fold.
 *
 * The Code tab is a VIEWER and not a door to one (D-054): it renders the
 * file card `files.read` wrote through the app's one code surface, which is
 * also what makes the hover and definition gestures work inside it. The read
 * itself belongs to the flow that opened the tab (state/controller/graph.ts),
 * so this component still reads nothing and holds nothing.
 */
import { memoryWords, type RunInputs } from "./RunInputs"
import { Suspense } from "react"
import { CodeSurface } from "../ViewModules"
import { fileModel } from "./FileCards"
import { ViewSkeleton } from "../ViewSkeleton"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { flowAction } from "../flows/FlowAction"
import { graphSelectArgs, graphTabArgs } from "../flows/FlowArgs"
import type { FlowName } from "../flows/FlowName"
import type { PlanCardNode } from "./FlowGraph"
import { stateWord, type NodeRun, type RunGraphNode } from "./FlowGraphStatus"
import type { Card } from "../state/AppState"
import type { RunCommand } from "./CardFamily"
import type { JournalRecord } from "./RunTrace"
import { FlowGraphTrigger } from "./FlowGraphTrigger"
import type { TriggerGraphNode } from "./FlowGraphTriggerNode"
import { describeSchedule } from "./TriggerEvents"
import type { DurationDisplay } from "./flowGraph/Durations"
import { durationWords } from "./RunTrace"
import { drawerTabAct } from "./flowGraph/TabKeys"

/* A refused declaration read: one sentence where the file would be; the reader's words stay behind Details and Open file asks again. */
const CODE_READ_FAILED: UserFailureCopy = { fault: "infra", sentence: "Smithers could not read this file. Not your fault.", actions: [] }
const codeReadFailure = (refused: { readonly message: string }) => describedFailure("FlowGraphCodeReadFailed", CODE_READ_FAILED, refused.message)

/** Which of a node's tabs the drawer is showing. */
export type DrawerTab = "in" | "declaration" | "code" | "output" | "events" | "attempts"

/** The tabs, in the order the strip lays them out. */
const TAB_ORDER: ReadonlyArray<DrawerTab> = ["declaration", "in", "code", "output", "events", "attempts"]

/** What one node declared it reads and writes, as the engine recorded it. */
export interface DrawerEffects {
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  /** `hard` is a boundary the engine enforces; `expected` is one it only measures. */
  readonly boundary: "hard" | "expected"
}

/**
 * One node as the drawer reads it, whichever card it came from.
 *
 * Every field beyond the first four is optional because the two sources know
 * different things: a plan carries the step key and a verdict and no
 * provenance, a run's recorded graph carries provenance and effects and no
 * key. A field the source does not have is absent, and the drawer draws
 * nothing for it.
 */
export interface DrawerNode {
  readonly id: string
  /** Open text: the plan scheduler and the interpreter name their kinds differently and both are true. */
  readonly kind: string
  readonly dependsOn: ReadonlyArray<string>
  readonly tier: "sealed" | "compensable" | "irreversible"
  /** The action or flow the node dispatches; a merge node dispatches neither (D-040). */
  readonly action?: string
  /** The plan's own step key. A recorded graph carries none. */
  readonly key?: string
  readonly previousKey?: string
  readonly keyChange?: "added" | "unchanged" | "re-keyed"
  /** The word this node is at: the plan's verdict, or the run's settlement (D-041). */
  readonly word?: string
  /** Where the declaration was written, repo-relative, when the writer knew (D-037, D-047). */
  readonly declaredAt?: { readonly path: string; readonly line: number }
  /** A forest node (RunForest.ts) has no records of its own: its drawer is its word and, where it has one, Open. */
  readonly forest?: true
  readonly door?: RunGraphNode["door"]
  /**
   * The execution whose journal recorded this node.
   *
   * Node ids are addresses within ONE graph and nothing more: a recorded run
   * carries several executions and more than one of them names `root`. A
   * reader of the journal that ignored this would draw another execution's
   * records under this node's heading.
   */
  readonly executionId?: string
  /**
   * The dispatch identities this node's attempts were recorded under, when
   * the card carried them rather than the journal.
   *
   * `attempt-started` carries a step key digest and no node id, so nothing
   * joins an attempt to a node without these (D-048). The journal is the
   * usual source and `nodeJournal` reads it; this is the same join stated by
   * a source that has no journal to read.
   */
  readonly stepKeyDigests?: ReadonlyArray<string>
  /**
   * How many attempts this node's dispatches ran as, as the engine counted
   * them (D-052). The walk settles a node once, so this is the dispatch's
   * count and not the walk's.
   */
  readonly attempts?: number
  /**
   * What the node settled with: the value for `built` and `clean`, the typed
   * failure for `failed`. It is the writer's own bounded, redacted preview
   * (D-052) and never the whole value, so the drawer states the size it was
   * cut from rather than pretending it has all of it.
   */
  readonly result?: { readonly preview: string; readonly bytes: number; readonly truncated: boolean }
}

/** The flows a drawer's acts run, and the card they address. */
export interface DrawerDoors {
  /** Opens a node's drawer, and closes it when the node is left off. */
  readonly select: Extract<FlowName, "runs.graph.select" | "flow.plan.select">
  readonly tab: Extract<FlowName, "runs.graph.tab" | "flow.plan.tab">
  /** The first argument both take: the run for a run's graph, the card for a plan. */
  readonly target: string
}

/**
 * One plan node, as the drawer reads it.
 *
 * `declaredAt` comes from the plan's own graph rather than from the node: it
 * is the builder's observation, deliberately outside the key material a node
 * is addressed by (D-054), so the card carries it beside the edges and the
 * caller joins the two by id.
 */
export const planDrawerNode = (
  node: PlanCardNode,
  declaredAt?: { readonly path: string; readonly line: number } | undefined,
  previous?: ReadonlyArray<PlanCardNode>
): DrawerNode => ({
  id: node.id,
  kind: node.kind,
  dependsOn: node.dependsOn,
  tier: node.tier,
  key: node.key,
  word: node.status,
  ...(previous === undefined ? {} : {
    previousKey: previous.find(prior => prior.id === node.id)?.key,
    keyChange: previous.some(prior => prior.id === node.id) ? previous.find(prior => prior.id === node.id)?.key === node.key ? "unchanged" : "re-keyed" : "added"
  }),
  ...(node.action === undefined ? {} : { action: node.action }),
  ...(declaredAt === undefined ? {} : { declaredAt })
})

/**
 * One recorded node and the state its records reached, as the drawer reads
 * them.
 *
 * The dispatch identities, the attempt count and the settled result all come
 * off the FOLD rather than off a second read of the journal: they are the
 * node's own settlement, and the fold is what reads a settlement (D-052).
 */
export const runDrawerNode = (node: RunGraphNode, run: NodeRun | undefined, executionId?: string): DrawerNode => ({
  id: node.id,
  kind: node.kind,
  dependsOn: node.dependsOn,
  tier: node.tier,
  word: node.word ?? stateWord(run),
  ...(node.forest === undefined ? {} : { forest: node.forest }),
  ...(node.door === undefined ? {} : { door: node.door }),
  ...(node.action === undefined ? {} : { action: node.action }),
  ...(node.declaredAt === undefined ? {} : { declaredAt: node.declaredAt }),
  ...(executionId === undefined ? {} : { executionId }),
  ...(run?.stepKeyDigests === undefined ? {} : { stepKeyDigests: run.stepKeyDigests }),
  ...(run === undefined || run.status === "pending" ? {} : { attempts: run.attempts }),
  ...(run?.result === undefined ? {} : { result: run.result })
})

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** The engine's envelope, as the `run-events` projection wraps each row. */
interface Envelope {
  readonly executionId?: string
  readonly generation: number
  readonly sequence: number
  readonly at: number
  readonly eventType: string
  readonly payload: Record<string, unknown>
}

const envelopeOf = (record: JournalRecord): Envelope | undefined => {
  if (record.kind !== "control.engine.event") return undefined
  const envelope = asRecord(record.payload)
  const payload = asRecord(envelope?.payload)
  const eventType = asString(envelope?.eventType)
  if (envelope === undefined || payload === undefined || eventType === undefined) return undefined
  return {
    ...(asString(envelope.executionId) === undefined ? {} : { executionId: asString(envelope.executionId)! }),
    generation: asNumber(envelope.generation) ?? 0,
    sequence: asNumber(envelope.sequence) ?? asNumber(record.sequence) ?? 0,
    at: asNumber(envelope.emittedAtMs) ?? asNumber(record.occurredAt) ?? 0,
    eventType,
    payload
  }
}

/** `flows.engine.node-settled` reads `node-settled`: the record's own last word. */
const shortType = (eventType: string): string => eventType.slice(eventType.lastIndexOf(".") + 1)

/** One declared path set, in the shapes `@smthrs/plan`'s FileSet carries; anything else is not drawn. */
const declarationLabel = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  const declaration = asRecord(value)
  if (declaration === undefined) return undefined
  if (declaration._tag === "Glob" && Array.isArray(declaration.include)) {
    const include = declaration.include.map(asString).filter((part): part is string => part !== undefined)
    return include.length === 0 ? undefined : include.join(" ")
  }
  if (declaration._tag === "TreeArtifact") return asString(declaration.path)
  if (declaration._tag === "Filegroup") return asString(declaration.name)
  return undefined
}

const labels = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.map(declarationLabel).filter((label): label is string => label !== undefined) : []

/** What one node declared, as the plan record beside the run carries it. */
const effectsOf = (value: unknown): DrawerEffects | undefined => {
  const effects = asRecord(value)
  if (effects === undefined) return undefined
  const boundary = effects.boundaryMode
  if (boundary !== "hard" && boundary !== "expected") return undefined
  return { reads: labels(effects.reads), writes: labels(effects.writes), boundary }
}

/**
 * One attempt of one of a node's dispatches.
 *
 * It is a pair of records, not one: `attempt-started` opens it and
 * `attempt-finished` closes it, both keyed by the step key digest and the
 * ordinal alone. A row whose closing record the journal does not carry is
 * still an attempt, and says only what it knows.
 */
export interface DrawerAttempt {
  /** The dispatch's own ordinal, from the record; never counted here. */
  readonly attempt: number
  /** Where the opening record sits in the journal, which is the list's order. */
  readonly sequence: number
  readonly state?: "succeeded" | "failed"
  /** What the attempt took, when the journal timed both of its ends. */
  readonly tookMs?: number
}

/** One row of the node's own journal. */
export interface DrawerEvent {
  readonly sequence: number
  readonly at: number
  readonly type: string
  /** The engine's own word for what the record says, when it says one. */
  readonly word?: string
}

/** A digest list as a node's record states it; anything else is no join at all. */
const digestsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.map(asString).filter((digest): digest is string => digest !== undefined) : []

/**
 * What this run's journal says about one node.
 *
 * The node's own records are the ones naming it; the attempt records join
 * only through the dispatch identities those records state, which is the join
 * D-048 asks the engine for. The declaration comes off the plan page that
 * carried the node, which is the only place the effects a node declared are
 * recorded.
 *
 * It is read in two passes because `attempt-started` is recorded BEFORE the
 * settlement that would name its digest: a single pass would reach the
 * attempt rows without yet knowing which of them are this node's.
 */
export const nodeJournal = (
  records: ReadonlyArray<JournalRecord>,
  node: DrawerNode
): {
  readonly effects?: DrawerEffects
  readonly events: ReadonlyArray<DrawerEvent>
  readonly attempts: ReadonlyArray<DrawerAttempt>
} => {
  const envelopes: Array<Envelope> = []
  let generation = 0
  for (const record of records) {
    const envelope = envelopeOf(record)
    if (envelope === undefined) continue
    /* Another execution's `root` is not this one's (FlowGraphStatus.ts). */
    if (node.executionId !== undefined && envelope.executionId !== node.executionId) continue
    if (envelope.generation > generation) generation = envelope.generation
    envelopes.push(envelope)
  }
  /*
   * A newer generation REWINDS this execution, exactly as the fold reads it:
   * what an earlier generation recorded describes work the rewind discarded,
   * and listing it beside the current run's records would say this node did
   * both.
   */
  const current = envelopes.filter((envelope) => envelope.generation === generation)
  const digests = new Set(node.stepKeyDigests ?? [])
  let effects: DrawerEffects | undefined
  for (const envelope of current) {
    if (asString(envelope.payload.nodeId) === node.id) {
      for (const digest of digestsOf(envelope.payload.stepKeyDigests)) digests.add(digest)
    }
    const graph = asRecord(envelope.payload.graph)
    if (graph === undefined || !Array.isArray(graph.nodes)) continue
    for (const summary of graph.nodes) {
      const declared = asRecord(summary)
      if (declared?.id !== node.id) continue
      effects = effectsOf(declared.effects) ?? effects
      for (const digest of digestsOf(declared.stepKeyDigests)) digests.add(digest)
    }
  }
  const events: Array<DrawerEvent> = []
  /*
   * One entry per (dispatch, ordinal): the two records of one attempt are
   * folded into the row a reader wants — which attempt, how it ended, how
   * long it took — rather than listed as the two rows they are written as.
   */
  const attempts = new Map<string, DrawerAttempt & { startedAt?: number }>()
  const seen = new Set<string>()
  for (const envelope of current) {
    const identity = `${envelope.eventType}\u0000${envelope.sequence}`
    if (seen.has(identity)) continue
    if (asString(envelope.payload.nodeId) === node.id) {
      seen.add(identity)
      events.push({
        sequence: envelope.sequence,
        at: envelope.at,
        type: shortType(envelope.eventType),
        ...(asString(envelope.payload.outcome) === undefined ? {} : { word: asString(envelope.payload.outcome)! })
      })
      continue
    }
    const digest = asString(envelope.payload.stepKeyDigest)
    const ordinal = asNumber(envelope.payload.attempt)
    const type = shortType(envelope.eventType)
    if (digest === undefined || ordinal === undefined || !digests.has(digest)) continue
    if (type !== "attempt-started" && type !== "attempt-finished") continue
    seen.add(identity)
    const key = `${digest}\u0000${ordinal}`
    const held = attempts.get(key)
    if (type === "attempt-started") {
      attempts.set(key, { ...(held ?? { attempt: ordinal, sequence: envelope.sequence }), attempt: ordinal, sequence: envelope.sequence, startedAt: envelope.at })
      continue
    }
    const state = asString(envelope.payload.state)
    const startedAt = held?.startedAt
    attempts.set(key, {
      attempt: ordinal,
      sequence: held?.sequence ?? envelope.sequence,
      ...(held?.startedAt === undefined ? {} : { startedAt: held.startedAt }),
      ...(state === "succeeded" || state === "failed" ? { state } : {}),
      ...(startedAt === undefined ? {} : { tookMs: Math.max(0, envelope.at - startedAt) })
    })
  }
  const listed = [...attempts.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ startedAt: _opened, ...row }): DrawerAttempt => row)
  return { ...(effects === undefined ? {} : { effects }), events, attempts: listed }
}

/**
 * The tabs this node has evidence for, in strip order.
 *
 * Code needs two facts, not one: where the declaration is, and which
 * revision that site was read out of. With a site alone the only file a
 * reader could be shown is whatever the working tree holds now, which is not
 * the code the node was keyed or driven from, so the tab is absent rather
 * than mislabelled (D-068).
 */
export const drawerTabs = (
  node: DrawerNode,
  journal: ReturnType<typeof nodeJournal>,
  sourceRevision?: string | undefined,
  inputs?: RunInputs | undefined
): ReadonlyArray<DrawerTab> =>
  TAB_ORDER.filter((tab) =>
    tab === "in" ? inputs !== undefined && (inputs.memory !== undefined || inputs.runsOn !== undefined || inputs.secrets.length > 0)
      : tab === "declaration" ? true
      : tab === "code" ? node.declaredAt !== undefined && sourceRevision !== undefined
      : tab === "output" ? node.result !== undefined
      : tab === "events" ? journal.events.length > 0
      : journal.attempts.length > 0
  )

/**
 * What a graph card's keyboard does, as the act it runs.
 *
 * Arrows walk the edges the graph drew, Enter and Space open the node the
 * focus is on and close it again, and Escape closes what is open. Every one
 * is the same flow a click runs, so
 * the keyboard reaches nothing the agent and the pointer cannot (THE
 * THREE-DOOR LAW), and nothing here holds a cursor of its own: the selection
 * on the card is the cursor.
 */
export const graphKeyAct = (
  key: string,
  graph: {
    readonly ids: ReadonlyArray<string>
    readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>
    readonly selected?: string | undefined
    /** The node the browser focus is on, when the gesture came from one. */
    readonly focused?: string | undefined
    readonly doors: DrawerDoors
  }
): { readonly flow: DrawerDoors["select"]; readonly args: string } | undefined => {
  const { ids, edges, selected, focused, doors } = graph
  if (key === "Escape") return selected === undefined ? undefined : { flow: doors.select, args: graphSelectArgs(doors) }
  /*
   * A node is a button, so it answers Space as well as Enter, and the open
   * one carries `aria-expanded="true"`, which advertises a toggle: the same
   * key on the node that is already open closes it.
   */
  if (key === "Enter" || key === " ") {
    if (focused === undefined) return undefined
    return focused === selected
      ? { flow: doors.select, args: graphSelectArgs(doors) }
      : { flow: doors.select, args: graphSelectArgs(doors, focused) }
  }
  const forward = key === "ArrowDown" || key === "ArrowRight"
  const back = key === "ArrowUp" || key === "ArrowLeft"
  if (!forward && !back) return undefined
  if (selected === undefined) {
    const first = forward ? ids[0] : ids.at(-1)
    return first === undefined ? undefined : { flow: doors.select, args: graphSelectArgs(doors, first) }
  }
  const along = edges.filter((edge) => (forward ? edge.from === selected : edge.to === selected))
  const next = forward ? along[0]?.to : along[0]?.from
  return next === undefined ? undefined : { flow: doors.select, args: graphSelectArgs(doors, next) }
}

const EMPTY: ReadonlyArray<JournalRecord> = []

/** One file as the app reads it: the `file` card's payload, unchanged. */
export type DrawerFile = Extract<Card, { kind: "file" }>["payload"]

/**
 * The file a node's declaration is in, out of the cards the conversation
 * already holds.
 *
 * The drawer does not read files: `files.read` does, and the card it writes
 * is the evidence. That is also what makes the hover and definition gestures
 * work here — they write onto this same payload — and it is why a node whose
 * file nobody has read yet shows the door instead of a viewer.
 */
export const fileFor = (
  files: ReadonlyArray<Extract<Card, { kind: "file" }>> | undefined,
  repo: string,
  declaredAt: { readonly path: string } | undefined,
  sourceRevision: string | undefined
): DrawerFile | undefined => {
  if (declaredAt === undefined || sourceRevision === undefined) return undefined
  /*
   * At this revision, and no other. A card of the same path read from the
   * working tree — which is what `files.read` without a revision answers —
   * holds bytes nobody recorded this node against, and showing it here would
   * label them as the code that ran (D-068).
   */
  return files?.find((card) =>
    card.payload.path === declaredAt.path &&
    card.payload.ref === sourceRevision &&
    (card.payload.repo === repo || card.payload.localRepoId === repo)
  )?.payload
}

/**
 * The declared file, inline.
 *
 * It is the file card's own surface (CodeSurface.tsx: Shiki, the anchored
 * line, the hover and go-to-definition bindings), lazily loaded like
 * everywhere else it is used, so there is one viewer in this app and the
 * drawer is not a second one. A file whose bytes are not text is stated by
 * the card that read it and is not printed here either.
 */
const DrawerCode = ({ file, line }: {
  readonly file: DrawerFile
  readonly line: number
  readonly onRunCommand: RunCommand
}) => {
  if (file.binary === true) return null
  return (
    <div className="flow-graph-code-file" data-line={line}>
      <Suspense fallback={<ViewSkeleton />}>
        <CodeSurface model={fileModel({ ...file, line })} view={{ maximized: false }} actions={[]} gestures={{}} onAction={() => {}} onView={() => {}} />
      </Suspense>
    </div>
  )
}

/** The tab word as the strip prints it: the engine's noun, capitalised once. */
const TAB_LABEL: Readonly<Record<DrawerTab, string>> = {
  in: "In",
  declaration: "Declaration",
  code: "Code",
  output: "Output",
  events: "Events",
  attempts: "Attempts"
}

/**
 * How big the value a preview was cut from is, in the units the writer
 * bounded it in (`@smthrs/journal` counts bytes, and 2 KiB is its cut).
 */
const byteWords = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`

/** The In tab: the memory the run was handed and what Jev withheld, where it ran, and the secret names its box can reach. */
const InputsPanel = ({ inputs }: { readonly inputs: RunInputs }) => (
  <div className="flow-graph-inputs">
    {inputs.memory === undefined ? null : (
      <>
        <p className="flow-graph-inputs-head" data-testid="run-inputs-memory">{memoryWords(inputs.memory)}</p>
        <ul className="flow-graph-inputs-list" aria-label="Memory">
          {inputs.memory.kept.map((item) => (
            <li key={`kept-${item.id}`} data-kept="true"><span aria-hidden>✓</span><span className="ghc-visually-hidden">in:</span> {item.id} <span className="flow-graph-inputs-p" title="relevance">{item.relevance.toFixed(2).replace(/^0/, "")}</span></li>
          ))}
          {inputs.memory.withheld.map((item) => (
            <li key={`withheld-${item.id}`} data-kept="false"><span aria-hidden>–</span><span className="ghc-visually-hidden">withheld:</span> {item.id} <span className="flow-graph-inputs-p" title="relevance">{item.relevance.toFixed(2).replace(/^0/, "")}</span></li>
          ))}
        </ul>
      </>
    )}
    {inputs.runsOn === undefined ? null : <p className="flow-graph-inputs-head" data-testid="run-inputs-where">runs on {inputs.runsOn}</p>}
    {inputs.secrets.length === 0 ? null : (
      <ul className="flow-graph-inputs-list" aria-label="Secrets">
        {inputs.secrets.map((secret) => (
          <li key={secret.name}><span aria-hidden>⚷</span> {secret.name}{secret.hosts.length === 0 ? null : <span className="flow-graph-inputs-p"> {secret.hosts.join(" ")}</span>}</li>
        ))}
      </ul>
    )}
  </div>
)

const Field = ({ name, children }: { readonly name: string; readonly children: React.ReactNode }) => (
  <>
    <dt>{name}</dt>
    <dd data-field={name}>{children}</dd>
  </>
)

/**
 * The node a graph card has open.
 *
 * `records` is the run's journal and is absent on a plan, which has none:
 * a plan states what WOULD run, so it has a declaration and nothing else.
 */
export const FlowGraphDrawer = ({
  node,
  tab,
  doors,
  duration,
  file,
  codeError,
  sourceRevision,
  records = EMPTY,
  inputs,
  onRunCommand
}: {
  /** What went into the run this node belongs to (RunInputs.ts): the In tab. */
  readonly inputs?: RunInputs | undefined
  readonly node: DrawerNode
  readonly tab?: DrawerTab | undefined
  readonly doors: DrawerDoors
  /**
   * The revision this graph's declaration sites were read at, when the card
   * carries one. Without it there is no Code tab at all (D-068).
   */
  readonly sourceRevision?: string | undefined
  /** The declared file, when the conversation already holds the card that read it. */
  readonly file?: DrawerFile | undefined
  /**
   * A refused read of a declared file, as the card recorded it.
   *
   * It is drawn only where it is about THIS node's file: one card holds one
   * refusal, and another node's is another node's business.
   */
  readonly codeError?: { readonly path: string; readonly message: string } | undefined
  /**
   * What this node's action tag has measured, from the `flow-durations`
   * collection (flowGraph/Durations.ts). A tag nothing measured has no row
   * and the drawer says nothing at all about what the node costs (D-053).
   */
  readonly duration?: DurationDisplay | undefined
  readonly records?: ReadonlyArray<JournalRecord>
  readonly onRunCommand: RunCommand
}) => {
  const journal = nodeJournal(records, node)
  const available = drawerTabs(node, journal, sourceRevision, inputs)
  /* A tab this node cannot fill falls back to the one it always has, never to an empty panel. */
  const shown = tab !== undefined && available.includes(tab) ? tab : available[0]!
  const crumbs = node.id.split(".")
  /*
   * A drawer is a labelled GROUP, not a landmark: a transcript holds as many
   * of these as it holds graphs, and twenty complementary landmarks is a
   * worse thing to hand a screen reader than none.
   */
  const strip = `${doors.target}-${node.id}`
  if (node.forest === true) {
    return (
      <aside className="flow-graph-drawer" role="group" data-node={node.id} aria-label={node.action ?? node.id}>
        <div className="flow-graph-drawer-head">
          <span className="flow-graph-drawer-tag">{node.action ?? node.id}</span>
          {node.word === undefined ? null : <span className="flow-graph-drawer-word" data-state={node.word}>{node.word}</span>}
          {node.door === undefined ? null
            : <button type="button" className="run-trace-filter" {...flowAction(onRunCommand, node.door.flow, node.door.args)}>Open</button>}
          <button type="button" className="flow-graph-drawer-close" aria-label="Close"
            {...flowAction(onRunCommand, doors.select, graphSelectArgs(doors))}>×</button>
        </div>
      </aside>
    )
  }
  return (
    <aside
      className="flow-graph-drawer"
      role="group"
      data-node={node.id}
      data-tab={shown}
      aria-label={node.action ?? node.id}
    >
      <div className="flow-graph-drawer-head">
        <span className="flow-graph-drawer-tag">{node.action ?? node.id}</span>
        {node.action === undefined ? null : <span className="flow-graph-drawer-id">{node.id}</span>}
        {node.word === undefined ? null : (
          <span className="flow-graph-drawer-word" data-state={node.word}>{node.word}</span>
        )}
        {/* The p50 its history measured, with how many runs that is: the claim
            and the evidence for it, in one line (D-053). The range rule is
            already in `text`, and a tag nothing measured has no row at all. */}
        {duration === undefined ? null : (
          <span className="flow-graph-drawer-duration" title={duration.detail}>
            <span className="flow-graph-duration-text">{duration.text}</span>
            <span className="flow-graph-duration-samples">
              {duration.samples} run{duration.samples === 1 ? "" : "s"}
            </span>
          </span>
        )}
        <button
          type="button"
          className="flow-graph-drawer-close"
          aria-label="Close"
          {...flowAction(onRunCommand, doors.select, graphSelectArgs(doors))}
        >
          ×
        </button>
      </div>
      {/*
        * One tab stop into the strip, then the arrows along it
        * (flowGraph/TabKeys.ts). Every move is the flow a click runs.
        */}
      <div
        className="flow-graph-drawer-tabs"
        role="tablist"
        onKeyDown={(event) => {
          const act = drawerTabAct(event.key, { tabs: available, shown, doors })
          if (act === undefined) return
          event.preventDefault()
          onRunCommand(act.flow, act.args)
        }}
      >
        {available.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${strip}-tab-${name}`}
            className="flow-graph-drawer-tab"
            data-tab={name}
            aria-selected={name === shown}
            aria-controls={`${strip}-panel`}
            tabIndex={name === shown ? 0 : -1}
            {...flowAction(onRunCommand, doors.tab, graphTabArgs(doors, name))}
          >
            {TAB_LABEL[name]}
            {/* The ENGINE's count of how many attempts the node ran as (D-052),
                which is not the number of rows the journal still holds. A node
                that ran once says nothing: one is what a step normally does. */}
            {name === "attempts" && node.attempts !== undefined && node.attempts > 1
              ? <span className="flow-graph-tab-count">{node.attempts}</span>
              : null}
          </button>
        ))}
      </div>
      <div
        className="flow-graph-drawer-body"
        role="tabpanel"
        id={`${strip}-panel`}
        aria-labelledby={`${strip}-tab-${shown}`}
        data-tab={shown}
      >
        {shown === "in" && inputs !== undefined ? <InputsPanel inputs={inputs} /> : shown === "declaration" ? (
          <>
            <dl className="flow-graph-declaration">
              <Field name="tier">{node.tier}</Field>
              <Field name="kind">{node.kind}</Field>
              {node.key === undefined ? null : <Field name="key">{node.key}</Field>}
              {node.keyChange === undefined ? null : <Field name="key change">{node.keyChange}</Field>}
              {node.previousKey === undefined || node.previousKey === node.key ? null : <Field name="previous key">{node.previousKey}</Field>}
              {journal.effects === undefined ? null : <Field name="boundary">{journal.effects.boundary}</Field>}
              {journal.effects === undefined || journal.effects.reads.length === 0 ? null : (
                <Field name="reads">{journal.effects.reads.join(" ")}</Field>
              )}
              {journal.effects === undefined || journal.effects.writes.length === 0 ? null : (
                <Field name="writes">{journal.effects.writes.join(" ")}</Field>
              )}
            </dl>
            {node.dependsOn.length === 0 ? null : (
              <div className="flow-graph-depends">
                {node.dependsOn.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="flow-graph-depends-node"
                    {...flowAction(onRunCommand, doors.select, graphSelectArgs(doors, id))}
                  >
                    {id}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : shown === "code" && node.declaredAt !== undefined ? (
          <div className="flow-graph-code" data-path={node.declaredAt.path}>
            <div className="flow-graph-code-head">
              <span className="flow-graph-code-path">{`${node.declaredAt.path}:${node.declaredAt.line}`}</span>
              {/* The plan node id IS the structural path through the flow's body (Graph.ts). */}
              <ol className="flow-graph-code-crumbs">
                {crumbs.map((crumb, index) => <li key={`${index}-${crumb}`}>{crumb}</li>)}
              </ol>
              {/*
                * The whole file, in the card that owns it, and the door that
                * asks again when a read was refused: THIS tab's own door,
                * which reads at the revision the sites were recorded at.
                * `files.read` names a path and no revision, so it answers the
                * working tree — a second card, holding bytes nobody recorded,
                * under the same title as the one this tab renders (D-068).
                */}
              <button
                type="button"
                className="flow-graph-code-open"
                {...flowAction(onRunCommand, doors.tab, graphTabArgs(doors, "code"))}
              >
                Open file
              </button>
            </div>
            {file === undefined
              ? codeError === undefined || codeError.path !== node.declaredAt.path
                ? null
                : <FailureNotice className="flow-graph-code-error" role="status"
                    failure={codeReadFailure(codeError)} />
              : <DrawerCode file={file} line={node.declaredAt.line} onRunCommand={onRunCommand} />}
          </div>
        ) : shown === "output" && node.result !== undefined ? (
          /*
           * The writer's own preview, and the size it was cut from. It is
           * redacted before it is cut and it is a PREFIX of JSON once the cut
           * happened, so the panel says the cut rather than ending mid-token
           * as if the value were complete. A failed node's result is its
           * typed failure, which is why the panel wears the node's word.
           */
          <div className="flow-graph-output" data-state={node.word}>
            <pre className="flow-graph-output-preview">{node.result.preview}</pre>
            <span className="flow-graph-output-bytes">{byteWords(node.result.bytes)}</span>
            {node.result.truncated ? <span className="flow-graph-output-truncated">cut</span> : null}
          </div>
        ) : shown === "events" ? (
          <ol className="flow-graph-events">
            {journal.events.map((event) => (
              <li key={`${event.type}-${event.sequence}`} data-seq={event.sequence}>
                <span className="flow-graph-event-seq">{event.sequence}</span>
                <span className="flow-graph-event-type">{event.type}</span>
                {event.word === undefined ? null : <span className="flow-graph-event-word">{event.word}</span>}
              </li>
            ))}
          </ol>
        ) : (
          /* One row per attempt: the ordinal the record states, how it ended
             and what it took. A row the journal never closed says only that. */
          <ol className="flow-graph-attempts">
            {journal.attempts.map((attempt) => (
              <li
                key={`${attempt.sequence}-${attempt.attempt}`}
                data-seq={attempt.sequence}
                data-attempt={attempt.attempt}
                {...(attempt.state === undefined ? {} : { "data-state": attempt.state })}
              >
                <span className="flow-graph-attempt-n">{attempt.attempt}</span>
                {attempt.state === undefined ? null : <span className="flow-graph-attempt-state">{attempt.state}</span>}
                {attempt.tookMs === undefined
                  ? null
                  : <span className="flow-graph-attempt-took">{durationWords(attempt.tookMs)}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  )
}


/**
 * What a canvas needs to drill into a node: the card the acts address, the
 * node that is open on it, and the door to run them through.
 *
 * It is one optional object rather than four props, so a surface without it
 * — a static preview, or a card rendered with the flow builder off — draws
 * exactly the canvas it drew before (D-038, D-050).
 */
export interface GraphDrill {
  readonly previousNodes?: ReadonlyArray<PlanCardNode> | undefined
  readonly repo: string
  /** The revision this graph's declaration sites were read at, when it has one (D-068). */
  readonly sourceRevision?: string | undefined
  readonly doors: DrawerDoors
  readonly selected?: string | undefined
  readonly tab?: DrawerTab | undefined
  /** The files this conversation has read; the Code tab renders the declared one inline. */
  readonly files?: ReadonlyArray<Extract<Card, { kind: "file" }>> | undefined
  /** A refused read of a declared file, as this card recorded it. */
  readonly codeError?: { readonly path: string; readonly message: string } | undefined
  readonly onRunCommand: RunCommand
}

/**
 * A schedule's drawer: the panel the dispatcher card already draws, opened on
 * the trigger node the reader picked.
 *
 * A trigger is not a plan node (D-031) — no key, no tier, no settlement — so
 * it gets the panel that knows what a schedule is rather than the tabs that
 * know what a plan node is.
 */
export const FlowGraphTriggerDrawer = ({
  trigger,
  repo,
  doors,
  onRunCommand
}: {
  readonly trigger: TriggerGraphNode
  readonly repo: string
  readonly doors: DrawerDoors
  readonly onRunCommand: RunCommand
}) => (
  <aside className="flow-graph-drawer" data-node={trigger.id} aria-label={trigger.row.id}>
    <div className="flow-graph-drawer-head">
      <span className="flow-graph-drawer-tag">{describeSchedule(trigger.row.cron, trigger.row.timezone)}</span>
      <span className="flow-graph-drawer-word" data-state={trigger.state}>{trigger.state}</span>
      <button
        type="button"
        className="flow-graph-drawer-close"
        aria-label="Close"
        {...flowAction(onRunCommand, doors.select, graphSelectArgs(doors))}
      >
        ×
      </button>
    </div>
    <div className="flow-graph-drawer-body" data-tab="schedule">
      <FlowGraphTrigger triggers={[trigger]} repo={repo} onRunCommand={onRunCommand} />
    </div>
  </aside>
)
