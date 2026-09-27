import * as PromptQueue from "@smthrs/rpc/PromptQueue"
import { useClock } from "@smthrs/ui/clock"
import { parseArgs } from "@smthrs/ui/flow-arguments"
import { NOTICE_SETTLE_MS } from "@smthrs/ui/notification-policy"
import * as Log from "./log.ts"
import * as TabCommand from "./tab-command.ts"
/**
 * The terminal UI: a transcript of cells above a composer.
 *
 * Keys and commands follow pi (`badlogic/pi-mono` coding-agent) wherever the
 * cell harness has the same idea; `editor.ts` lists them. `view.tsx` draws.
 */
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { flushSync, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import * as Form from "@smthrs/ui/flow-form"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import stringWidth from "string-width"
import { ActivityView } from "./activity-view.tsx"
import * as Agents from "./agents.ts"
import * as AppView from "./app-view.tsx"
import { CompletionMenu, FlowFormView, PickerDialog, StatusLine } from "./app-view.tsx"
import * as Approvals from "./approvals.ts"
import * as Clipboard from "./clipboard.ts"
import * as Composer from "./composer.ts"
import * as Context from "./context.ts"
import * as Contributions from "./contributions.ts"
import * as Cursor from "./cursor.ts"
import * as Editor from "./editor.ts"
import * as Estimate from "./estimate.ts"
import * as Extension from "./extension.ts"
import * as External from "./external.ts"
import * as Files from "./files.ts"
import { actions as flowActions, FlowRuns, type Port as FlowPort } from "./flows.ts"
import type * as Host from "./host.ts"
import * as Improve from "./improve.ts"
import * as Dispatch from "./key-dispatch.ts"
import * as Keys from "./keys.ts"
import * as Models from "./models.ts"
import * as Monitors from "./monitors.ts"
import * as Palette from "./palette.ts"
import { PanelView } from "./panel-view.tsx"
import * as Panels from "./panels.ts"
import * as Pickers from "./picker.ts"
import * as Scrubber from "./scrubber.ts"
import * as Session from "./session.ts"
import * as Shell from "./shell.ts"
import * as Smithers from "./smithers.ts"
import * as Steering from "./steering.ts"
import * as Summary from "./summary.ts"
import * as Surfaces from "./surfaces.ts"
import { tabTitle } from "./surfaces.ts"
import { chip as workerChip, TabStrip, WorkerList, WorkerView } from "./tabs-view.tsx"
import * as Tabs from "./tabs.ts"
import { color, isTheme, loadTheme, saveTheme, setTheme, spinner } from "./theme.ts"
import * as Timeline from "./timeline.ts"
import * as Toasts from "./toasts.ts"
import * as TranscriptView from "./transcript-view.ts"
import * as Transcript from "./transcript.ts"
import * as Undo from "./undo.ts"
import * as View from "./view.tsx"
import * as Watch from "./watch.ts"
import { seats, type Snapshot, type Tab, Workspace } from "./workspace.ts"

/** The transcript and composer never grow wider than this, like the app's chat column. */
const columnWidth = 120

export interface AppProps {
  readonly host: Host.Host
  readonly seat: string
  readonly workerSeat?: string
  readonly models: ReadonlyArray<Models.Model>
  /** Resolves a custom agent's `model:`; default `Models.seatOf` over `models`. Replay pins every seat. */
  readonly seatOf?: (declared: string) => string | undefined
  readonly contextWindow: (seat: string) => number
  /** A session file to continue, or undefined for a new one. */
  readonly resume?: string
  /** Open the session picker at start (`--resume`). */
  readonly pickSession?: boolean
  readonly branch?: string
  /** The directory's file flows; absent where flows cannot run. */
  readonly flows?: FlowPort
}

interface TurnState {
  readonly handle: Host.Turn
  readonly startedAt: number
  readonly steering: Steering.Queue
  /** The turn's id in the estimate ledger. */
  readonly estimate: string
}

type Picker = Pickers.Picker

type FlowForm = Dispatch.FlowForm

export function App(props: AppProps) {
  const renderer = useRenderer()
  const [, refreshTheme] = useState(0)
  useState(() => setTheme(loadTheme()))
  const [restored] = useState((): {
    current: ReturnType<typeof Session.restore> | undefined
    file: string | undefined
    /** The interrupted turn's outcome, appended once the writer exists. */
    receipt?: Session.Record
    damaged?: string
  } => {
    if (props.resume === undefined) return { current: undefined, file: undefined }
    try {
      const recovered = Session.recover(Session.load(props.resume))
      return { current: Session.restore(recovered.records), file: props.resume, receipt: recovered.receipt }
    } catch (error) {
      return { current: undefined, file: undefined, damaged: Session.quarantine(props.resume, error) }
    }
  })
  const [transcript, setTranscript] = useState(restored.current?.transcript ?? Transcript.empty)
  const [compact, setCompact] = useState<number | undefined>()
  const [seat, setSeat] = useState(props.seat)
  const [thinking, setThinking] = useState<Editor.Thinking>(undefined)
  const [turn, setTurn] = useState<TurnState | undefined>()
  const [shell, setShell] = useState<Shell.Running | undefined>()
  /** When an undo started; set from the confirm until its real settlement. */
  const [undoing, setUndoing] = useState<number | undefined>()
  const [followUps, setFollowUps] = useState<ReadonlyArray<PromptQueue.Prompt>>(restored.current?.queued ?? [])
  const [picker, setPicker] = useState<Picker | undefined>(
    props.pickSession === true
      ? { kind: "resume", query: "", selected: 0, sessions: Session.list(props.host.cwd) }
      : undefined
  )
  const [expanded, setExpanded] = useState(false)
  const { toast, setStatus, clearFailure } = Toasts.useToast()
  const [name, setName] = useState(restored.current?.name)
  const [approvals, setApprovals] = useState<ReadonlyArray<Approvals.Pending>>([])
  // Answered but maybe still listed: a poll can land before the store drops it.
  const answered = useRef(new Set<string>())
  // When the front row starts taking y, n and a; see `Approvals.Arming`.
  const arming = useRef(Approvals.idle)
  const entries = useRef<Array<Context.Entry>>(restored.current?.entries ?? [])
  // A record the disk refused never stops the screen: the row says what went unsaved.
  const unsaved = useCallback((failure: Session.WriteFailed) => {
    const text = `Session not saved: ${failure.message}`
    setStatus(text, "danger")
    setTranscript((current) => Transcript.alert(current, text, Date.now()))
  }, [])
  const writer = useRef<Session.Writer>(
    Session.guarded(
      restored.file === undefined ? Session.create(props.host.cwd) : Session.reopen(restored.file),
      unsaved
    )
  )
  // The interrupted turn's receipt, once: nothing runs it after a restart.
  useEffect(() => {
    if (restored.receipt !== undefined) writer.current.append(restored.receipt)
  }, [])
  /** Status items, keys and plugin panels from every owner; runtime panels stay in the workspace. */
  const [contributions] = useState(() => {
    const store = new Contributions.Store({ taken: Keys.taken })
    for (const each of restored.current?.contributions ?? []) {
      try {
        store.runtime(each.owner, each.contribution)
      } catch { /* A key a newer built-in took stays off. */ }
    }
    return store
  })
  /** A cell's status item or key: shown, then persisted; a refusal reaches the cell instead. */
  const contribute = useCallback((owner: string, contribution: Extension.Contribution) => {
    contributions.runtime(owner, contribution)
    if (contribution.kind !== "panel") writer.current.append({ type: "contribution", owner, contribution })
  }, [contributions])
  // Agents read the current session's flow runs: their listing, and a fresh one at launch.
  const runsRef = useRef<FlowRuns | undefined>(undefined)
  const workspaceRef = useRef<Workspace | undefined>(undefined)
  const makeWorkspace = (restoredTabs?: Snapshot) =>
    new Workspace({
      occupied: (id) => runsRef.current?.has(id) ?? false,
      host: props.host,
      workerSeat: props.workerSeat ?? props.seat,
      history: () => entries.current,
      persist: writer.current.append,
      ...(restoredTabs === undefined ? {} : { restored: restoredTabs }),
      ...(props.flows === undefined ? {} : {
        agents: Agents.port({
          known: () => runsRef.current?.known(),
          listing: () => runsRef.current?.listing() ?? Promise.reject(new Error("Flows unavailable"))
        }, props.flows)
      }),
      seatOf: props.seatOf ?? ((declared) => Models.seatOf(declared, props.models)),
      contribute
    })
  const [workspace, setWorkspace] = useState(() => makeWorkspace(restored.current?.workspace))
  const [revision, setRevision] = useState(0)
  const [runs, setRuns] = useState(() =>
    new FlowRuns({
      occupied: (id) => workspaceRef.current?.has(id) ?? false,
      port: props.flows,
      persist: writer.current.append,
      restored: restored.current?.flows
    })
  )
  /** Monitor updates reach the screen through this; it is set once the toast exists. */
  const deliver = useRef<(delivery: Monitors.Delivery) => void>(() => {})
  const makeMonitors = (
    tabs: Workspace,
    flows: FlowRuns,
    persist: Session.Writer["append"],
    restoredMonitors?: ReadonlyArray<Monitors.Monitor>
  ) =>
    new Monitors.Monitors({
      judged: props.host.judged && props.host.monitor !== undefined,
      observe: Monitors.observer({
        tab: tabs.read,
        run: flows.read,
        shell: (command, signal) => {
          const running = Shell.run({ command, cwd: props.host.cwd, onOutput: () => {} })
          const timer = setTimeout(running.cancel, 30_000)
          signal?.addEventListener("abort", running.cancel, { once: true })
          if (signal?.aborted) running.cancel()
          return running.done.finally(() => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", running.cancel)
          })
        }
      }),
      judge: (input) => props.host.monitor!.judge(input),
      compose: (input) => props.host.monitor!.compose(input),
      deliver: (delivery) => deliver.current(delivery),
      persist,
      subscribe: (source, listener) =>
        source.kind === "tab" ? tabs.subscribe(listener) : source.kind === "run" ? flows.subscribe(listener) : () => {},
      ...(restoredMonitors === undefined ? {} : { restored: restoredMonitors }),
      // A restored shell monitor asks again under this session's approval mode.
      ...(props.host.approvals === undefined ? {} : {
        authorize: Approvals.restored((requests) => props.host.approvals!.authorize(requests))
      })
    })
  const [monitors, setMonitors] = useState(() =>
    makeMonitors(workspace, runs, writer.current.append, restored.current?.monitors)
  )
  useEffect(() => () => {
    void monitors.dispose()
  }, [monitors])
  // One ledger per directory: every session's work calibrates the next estimate.
  // Its failures toast once each, through a ref the render sets.
  const estimateProblem = useRef((_: string) => {})
  const [estimator] = useState(() =>
    new Estimate.Estimator({
      ledger: new Improve.Ledger(Estimate.ledgerFile(props.host.cwd), {
        onWriteError: (error) =>
          estimateProblem.current(`Estimates not saved: ${error instanceof Error ? error.message : String(error)}`)
      }),
      model: props.host.complete === undefined
        ? undefined
        : (request) => props.host.complete!({ ...request, seat: Models.delegateModels.luna }),
      onFailure: (failure) =>
        estimateProblem.current(`Estimate model failed: ${failure.message.split("\n")[0]!.slice(0, 80)}`)
    })
  )
  runsRef.current = runs
  workspaceRef.current = workspace
  const files = useRef(Files.lister(props.host.cwd, Date.now, () => setRevision((value) => value + 1)))
  const {
    composer,
    draft,
    setText,
    history,
    parkedDraft,
    menu,
    menuIndex,
    liveMenu,
    setMenuIndex,
    dismissMenu,
    accept,
    externalEditor,
    stopEditor,
    onContentChange,
    onCursorChange
  } = Composer.useComposer({
    models: props.models,
    runs,
    revision,
    files,
    arming,
    prompts: restored.current?.prompts ?? []
  })
  /** Runs the user started here; their form opens without a key. */
  const userRuns = useRef(new Set<string>())
  const formOpened = useRef(new Set<string>())
  const [form, setForm] = useState<FlowForm | undefined>()
  // Keys read the form through this, so typing then Enter never submits a stale draft.
  const liveForm = useRef<FlowForm | undefined>(undefined)
  const changeForm = useCallback((next: FlowForm | undefined) => {
    liveForm.current = next
    setForm(next)
  }, [])
  const {
    surface,
    setSurface,
    panelFocus,
    setPanelFocus,
    navigation,
    setNavigation,
    steerTarget,
    setSteerTarget,
    showTab,
    stepTab
  } = Surfaces.useSurface()
  const [whichKey, setWhichKey] = useState(false)
  const whichKeyRef = useRef(false)
  const keyScroll = useRef<ScrollBoxRenderable | null>(null)
  const setWhichKeyOpen = useCallback((open: boolean) => {
    whichKeyRef.current = open
    setWhichKey(open)
  }, [])
  const [filter, setFilter] = useState(Timeline.all)
  useEffect(() => workspace.subscribe(() => setRevision((value) => value + 1)), [workspace])
  useEffect(() => () => workspace.dispose(), [workspace])
  useEffect(() => runs.subscribe(() => setRevision((value) => value + 1)), [runs])
  useEffect(() => contributions.subscribe(() => setRevision((value) => value + 1)), [contributions])
  useEffect(() => {
    runs.refresh()
    const warm = setTimeout(() => runs.warm(), 0)
    return () => {
      clearTimeout(warm)
      void runs.dispose()
    }
  }, [runs])
  // Every listing replaces the `repo:` contributions; `metadata.tui` is metadata, so nothing is imported.
  useEffect(() => {
    const sync = () => contributions.repo(runs.listed().map(Extension.declared))
    sync()
    return runs.subscribe(sync)
  }, [runs, contributions])
  // Hot reload: a new or edited flow re-lists within one debounce.
  const flowWatch = useRef<Watch.Watcher | undefined>(undefined)
  useEffect(() => {
    if (props.flows === undefined) return
    const watcher = Watch.flows(props.host.cwd, () => runs.refresh())
    flowWatch.current = watcher
    return () => watcher.dispose()
  }, [runs, props.flows, props.host.cwd])
  const flowRuns = runs.snapshot()
  useEffect(() => estimator.subscribe(() => setRevision((value) => value + 1)), [estimator])
  useEffect(() => {
    const timer = setTimeout(() => estimator.seed(join(Session.directory(props.host.cwd), "workers")), 0)
    return () => clearTimeout(timer)
  }, [estimator, props.host.cwd])
  useEffect(() => {
    estimator.tabs(workspace.snapshot().tabs)
    estimator.flows(runs.snapshot(), (flow) => runs.listed().find((listed) => listed.name === flow)?.description)
  }, [estimator, workspace, runs, revision])
  /** Opens a run's form for its missing input. */
  const openForm = useCallback((id: string) => {
    const run = runs.get(id)
    if (run?.status !== "input") return
    const schema = runs.schema(id)
    const fields = schema === undefined ? [] : Form.formFieldsFor(schema)
    setPanelFocus(false)
    changeForm({ id, flow: run.flow, fields, draft: Form.draftFrom(fields, run.input, "json"), focus: 0 })
  }, [runs, changeForm])
  useEffect(() => {
    const open = liveForm.current
    if (open !== undefined) {
      const status = runs.get(open.id)?.status
      // A pending tool approval takes the keys; the run stays parked and `a` in its tab reopens the form.
      if (status !== "input" || approvals.length > 0) changeForm(undefined)
      return
    }
    // Never pull the keyboard away from a draft, a dialog or an approval; a later render opens it.
    if (draft !== "" || picker !== undefined || approvals.length > 0) return
    for (const run of flowRuns) {
      const key = `${run.id}:${run.status}`
      if (!userRuns.current.has(run.id) || run.status !== "input") continue
      if (formOpened.current.has(key)) continue
      formOpened.current.add(key)
      return openForm(run.id)
    }
  }, [revision, runs, openForm, changeForm, approvals, picker, draft])
  const snapshot = workspace.snapshot()
  const { search, parsed: parsedPalette } = Pickers.useSearch({ picker, setPicker, cwd: props.host.cwd, setStatus })
  // One shared clock drives foreground and background progress through settlement.
  const sampledAt = Date.now()
  const clockRunning = turn !== undefined || shell !== undefined || undoing !== undefined || workspace.busy ||
    runs.busy || flowRuns.some((run) => run.endedAt !== undefined && sampledAt - run.endedAt < NOTICE_SETTLE_MS) ||
    search?.status === "running" ||
    snapshot.tabs.some((tab) => tab.endedAt !== undefined && sampledAt - tab.endedAt < NOTICE_SETTLE_MS)
  const now = useClock(clockRunning, 100)
  const eta = (id: string, status: string, startedAt: number) => {
    if (
      status === "done" || status === "failed" || status === "cancelled" || status === "parked" || status === "waiting"
    ) return ""
    // Queued work has not started: its label is the whole estimate.
    const text = Estimate.label(estimator.get(id), status === "queued" ? now : startedAt, now)
    return text === "" ? "" : ` ${text}`
  }
  const cardIds = new Set(snapshot.cards ?? [])
  /**
   * A repository flow's latest run or agent tab, as the status item
   * `metadata.tui.status` asks for. An agent tab names its agent in `agent`.
   */
  const liveStatus = (flow: string): Extension.Status | undefined => {
    const latest = [
      ...flowRuns.filter((each) => each.flow === flow).map((run) => ({
        at: run.startedAt,
        surface: `flow:${run.id}`,
        status: run.status === "done" || run.status === "failed" || run.status === "cancelled" ? run.status : "running"
      })),
      ...snapshot.tabs.filter((tab) => tab.agent?.name === flow).map((tab) => ({
        at: tab.startedAt,
        surface: `tab:${tab.id}`,
        status: tab.status === "done" || tab.status === "failed" || tab.status === "cancelled" ? tab.status : "running"
      }))
    ].sort((a, b) => b.at - a.at)[0]
    return latest === undefined ? undefined : {
      id: flow,
      text: `${
        latest.status === "done" ? "✓" : latest.status === "failed" ? "✗" : latest.status === "cancelled" ? "■" : "◌"
      } ${flow}`.slice(0, 24),
      tone: latest.status === "failed" ? "danger" : latest.status === "done" ? "success" : "info",
      action: { kind: "open", surface: latest.surface }
    }
  }
  const extensions = contributions.snapshot(liveStatus)
  const extensionPanel: Panels.Panel | undefined = extensions.problems.length === 0 ? undefined : {
    id: "extensions",
    title: "Extensions",
    summary: `${extensions.problems.length} ${extensions.problems.length === 1 ? "problem" : "problems"}.`,
    rows: extensions.problems.map((problem, index) => ({
      id: String(index),
      label: problem,
      status: "failed",
      details: []
    }))
  }
  /** `ui:<id>` views: runtime tabs, plugin panels, the problems view, and any card while it is open. */
  const uiPanels: ReadonlyArray<Panels.Panel> = [
    ...snapshot.panels.filter((each) => !cardIds.has(each.id) || surface === `ui:${each.id}`),
    ...extensions.panels.filter((each) => each.placement === "tab" || surface === `ui:${each.panel.id}`).map((each) =>
      each.panel
    ),
    ...(extensionPanel === undefined ? [] : [extensionPanel])
  ]
  /** A card's panel as it is now: a workspace panel, a plugin card, or a flow run's view. */
  const livePanel = (card: Panels.Panel): Panels.Panel =>
    card.id.startsWith("flow:") && runs.has(card.id.slice(5))
      ? { ...runs.panel(card.id.slice(5)), id: card.id }
      : snapshot.panels.find((each) => each.id === card.id) ??
        extensions.panels.find((each) => each.panel.id === card.id)?.panel ?? card
  const statusItems: ReadonlyArray<Extension.Status> = [
    ...(extensionPanel === undefined ? [] : [{
      id: "extensions",
      text: `✗ ${extensions.problems.length} ${extensions.problems.length === 1 ? "extension" : "extensions"}`,
      tone: "danger" as const,
      action: { kind: "open" as const, surface: "ui:extensions" }
    }]),
    ...extensions.status.map((each) => each.status)
  ].slice(0, Contributions.limits.shownStatus)
  const merged = Keys.bindings(extensions.keys)
  // A plugin's tab shows only while open: tab keys never stop on it (`/smithers` opens Smithers).
  const pluginPanels = uiPanels.filter((panel) =>
    extensions.panels.some((each) => each.placement === "tab" && each.panel === panel)
  )
  const pluginTabs = pluginPanels.filter((panel) => surface === `ui:${panel.id}`)
  // Built-in plugin: the Smithers surface, a `plugin:smithers` tab over the flow runs.
  const smithersPanel = props.flows === undefined && flowRuns.length === 0
    ? undefined
    : Smithers.panel(runs.listed(), flowRuns)
  const smithersKey = smithersPanel === undefined ? "" : JSON.stringify(smithersPanel)
  useEffect(() => {
    contributions.plugin(
      "smithers",
      smithersPanel === undefined ? [] : [{ kind: "panel", placement: "tab", panel: smithersPanel }]
    )
  }, [contributions, smithersKey])
  // Built-in plugin: monitors, one `plugin:monitors` status item while any is active.
  useEffect(() => {
    const sync = () => {
      const active = monitors.list().filter((each) => each.status === "active")
      contributions.plugin(
        "monitors",
        active.length === 0 ? [] : [{
          kind: "status",
          status: {
            id: "monitors",
            text: (active.length === 1 ? `◉ ${active[0]!.title}` : `◉ ${active.length} monitors`).slice(0, 24),
            tone: "info"
          }
        }]
      )
    }
    sync()
    return monitors.subscribe(sync)
  }, [monitors, contributions])
  // `metadata.tui.card`: each run of that flow started here shows as a live card in the chat.
  const mountedAt = useRef(Date.now())
  const carded = useRef(new Set<string>())
  const cardFlows = extensions.cards.join("\n")
  useEffect(() => {
    if (cardFlows === "") return
    for (const run of flowRuns) {
      if (run.startedAt < mountedAt.current || carded.current.has(run.id) || !extensions.cards.includes(run.flow)) {
        continue
      }
      carded.current.add(run.id)
      const card = runs.panel(run.id)
      setTranscript((current) => Transcript.card(current, card, run.startedAt))
    }
  }, [revision, runs, cardFlows])
  const tabEta = (tab: Tab) => eta(Estimate.tabId(tab), tab.status, Estimate.tabStart(tab)).trim()
  const tick = spinner[Math.floor(now / 100) % spinner.length]!
  const surfaces = Surfaces.chips({
    workspace: snapshot,
    runs: flowRuns,
    plugins: pluginTabs,
    views: uiPanels.filter((panel) => !pluginPanels.includes(panel)),
    worker: (tab) => workerChip({ ...tab, title: tabTitle(tab) }, props.models, now, tick, tabEta(tab)),
    runEta: (run) => eta(Estimate.runId(run), run.status, run.launchedAt ?? run.startedAt)
  })
  const clickTab = (id: string) => {
    flushSync(() => {
      if (liveForm.current !== undefined) changeForm(undefined)
      showTab(id)
    })
  }
  useEffect(() => {
    if (surface.startsWith("flow:")) void runs.hydrate(surface.slice(5))
  }, [surface, runs])
  const workerTab = surface.startsWith("tab:") ? snapshot.tabs.find((tab) => `tab:${tab.id}` === surface) : undefined
  const selectedFlowActions = flowActions(surface.startsWith("flow:") ? runs.get(surface.slice(5)) : undefined)
  /** The worker the composer steers: set by `s` in its tab, and only while that tab shows and runs. */
  const steered = workerTab !== undefined && workerTab.id === steerTarget && workerTab.status === "running"
    ? workerTab
    : undefined
  /** Back to the chat with the worker's lane shown and scrolled into view. */
  const openInChat = (id: string) => {
    setFilter((current) => (current.sources.includes(id) ? Timeline.toggleSource(current, id) : current))
    revealLane(id)
    showTab("chat")
  }
  const workerAction = (tab: Tab, action: Tabs.ActionId) => {
    switch (action) {
      case "stop":
        return workspace.cancel(tab.id)
      case "retry":
        try {
          workspace.retry(tab.id)
          return
        } catch (error) {
          return setStatus(error instanceof Error ? error.message : String(error), "warning")
        }
      case "model":
        return flushSync(() => setPicker({ kind: "worker-model", id: tab.id, query: "", selected: 0 }))
      case "wait":
        try {
          return workspace.waitForReset(tab.id)
        } catch (error) {
          return setStatus(error instanceof Error ? error.message : String(error), "warning")
        }
      case "steer":
        return flushSync(() => {
          setSteerTarget(tab.id)
          setPanelFocus(false)
        })
      case "open-chat":
        return flushSync(() => openInChat(tab.id))
    }
  }
  const { base: basePanel, panel } = Surfaces.panelFor(surface, {
    summary: () => Summary.panel(transcript),
    tab: workspace.panel,
    run: runs.panel,
    tree: workspace.tree,
    views: uiPanels
  })
  const focusMain = basePanel?.placement === "main"
  /** Approval keys the focused panel acts on: its `a` runs the selected row's action or opens a flow's form. */
  const panelKeys = panelFocus && panel !== undefined &&
      (surface.startsWith("flow:") ||
        panel.rows[Math.min(navigation.selected, panel.rows.length - 1)]?.action !== undefined)
    ? ["a"]
    : []
  const {
    scroll,
    dragScroll,
    lanes,
    timeline,
    cardKeys,
    focusedCard,
    setCardFocus,
    reveal,
    revealLane,
    monitored,
    showActivity,
    activeInspection,
    jumpTarget,
    transcriptOf,
    inspectActivity,
    followLive,
    clearInspection
  } = TranscriptView.useTranscriptView({
    renderer,
    transcript,
    tabs: snapshot.tabs,
    worker: workspace.transcript,
    filter,
    surface,
    setSurface,
    panel,
    setPanelFocus
  })
  const panelScroll = useRef<((direction: number) => void) | undefined>(undefined)
  const lastCtrlC = useRef(0)
  const dimensions = useTerminalDimensions()
  useEffect(() => Log.subscribe((message) => setStatus(message, "danger")), [setStatus])
  const discoveryFailure = runs.failure()
  useEffect(() => {
    if (discoveryFailure !== undefined) setStatus(discoveryFailure.message, "danger")
  }, [discoveryFailure, setStatus])
  deliver.current = (delivery) => {
    const text = `${delivery.title}: ${delivery._tag === "update" ? delivery.text : Monitors.message(delivery.failure)}`
    setStatus(text, delivery._tag === "update" ? "info" : "danger")
    setTranscript((current) =>
      delivery._tag === "update"
        ? Transcript.note(current, text, delivery.at)
        : Transcript.alert(current, text, delivery.at)
    )
  }
  useEffect(() => {
    if (restored.damaged !== undefined) setStatus(restored.damaged, "danger")
  }, [])
  estimateProblem.current = (text) => setStatus(text, "warning")

  // A dialog's rows follow the dialog and its sources, never the 100 ms clock: the palette ranks every file.
  const tabsKey = snapshot.tabs.map((tab) => `${tab.id}\0${tab.title}\0${tab.status}`).join("\n")
  /** Contributed keys and status items the palette can run. */
  const paletteActions: NonNullable<Palette.Sources["actions"]> = [
    ...extensions.keys.map(({ key }) => ({
      key: `key:${key.id}`,
      label: key.label,
      hint: key.key,
      action: key.action
    })),
    ...statusItems.flatMap((item) =>
      item.action === undefined ? [] : [{ key: `status:${item.id}`, label: item.text, action: item.action }]
    )
  ]
  const actionsKey = JSON.stringify(paletteActions)
  const rows = useMemo(
    () =>
      picker === undefined
        ? []
        : Pickers.rows(
          picker,
          props.models,
          seat,
          filter,
          snapshot.tabs,
          files.current,
          search?.hits ?? [],
          runs.listed(),
          paletteActions
        ),
    [picker, props.models, seat, filter, tabsKey, search?.hits, runs, revision, actionsKey]
  )

  // Key handlers read the latest values through these, never a stale render.
  // `now` is the clock the approval row rendered with, so its keys and its hints agree.
  const live = useRef({ turn, shell, undoing, followUps, seat, thinking, picker, approvals, now, whichKey, steered })
  live.current = { turn, shell, undoing, followUps, seat, thinking, picker, approvals, now, whichKey, steered }

  /** Sets the follow-up queue for the screen and for keys handled before the next render. */
  const setQueue = useCallback((next: ReadonlyArray<PromptQueue.Prompt>) => {
    live.current.followUps = next
    setFollowUps(next)
  }, [])
  /** Admits a follow-up: recorded in the session file, then shown. */
  const enqueue = useCallback((text: string) => {
    const next = PromptQueue.enqueue(live.current.followUps, { id: crypto.randomUUID(), text, scope: "chat" })
    if (next === live.current.followUps) return
    writer.current.append({ type: "queued", at: Date.now(), prompt: next.at(-1)! })
    setQueue(next)
  }, [setQueue])
  /** Takes the oldest follow-up for its turn; the record precedes the turn's own prompt. */
  const dequeue = useCallback((): string | undefined => {
    const [first, ...rest] = live.current.followUps
    if (first === undefined) return undefined
    writer.current.append({ type: "dequeued", at: Date.now(), id: first.id, reason: "started" })
    setQueue(rest)
    return first.text
  }, [setQueue])

  useEffect(() => {
    renderer.setTerminalTitle(`smithers - ${basename(props.host.cwd)}`)
  }, [renderer, props.host.cwd])

  useEffect(() =>
    Clipboard.copyOnSelect(
      renderer,
      (text) => Clipboard.write(text, Clipboard.commands(process.platform, process.env)),
      () => setStatus("Copied"),
      () => setStatus("Copy failed: no pbcopy, wl-copy, xclip or xsel", "warning")
    ), [renderer])

  // The store has no subscription; a request exists only while work runs, so
  // it is read on its own slower poll while the work clock runs.
  useEffect(() => {
    const ports = props.host.approvals
    if (ports === undefined || ports.mode !== "ask") return
    if (!clockRunning) return setApprovals((current) => (current.length === 0 ? current : []))
    let active = true
    const stop = Approvals.poll(() =>
      ports.pending().then(
        (listed) => {
          if (!active) return
          arming.current = Approvals.shown(arming.current, listed, Date.now(), answered.current)
          const next = listed.filter((request) => !answered.current.has(request.requestId))
          setApprovals((current) =>
            current.length === next.length && current.every((each, index) => each.requestId === next[index]!.requestId)
              ? current
              : next
          )
        },
        (error) => setStatus(String(error), "danger")
      )
    )
    return () => {
      active = false
      stop()
    }
  }, [clockRunning, props.host, setStatus])

  const quitting = useRef(false)
  const quit = useCallback(() => {
    if (quitting.current) return
    quitting.current = true
    flowWatch.current?.dispose()
    workspace.dispose()
    const monitorsStopped = monitors.dispose()
    const stopped = runs.dispose()
    live.current.turn?.handle.cancel()
    const shell = live.current.shell
    shell?.cancel()
    const editorStopped = stopEditor()
    if (editorStopped === undefined) renderer.destroy()
    void External.bounded(Promise.allSettled([
      shell?.done,
      editorStopped,
      monitorsStopped,
      stopped.then(() => Promise.allSettled([props.host.dispose(), props.flows?.dispose()]))
    ]))
      .then(() => {
        renderer.destroy()
        process.exit(0)
      })
  }, [renderer, props.host, props.flows, workspace, runs, monitors, stopEditor])

  useEffect(() => {
    // Terminal teardown alone leaves hosts and detached shell groups alive.
    // Run the same bounded shutdown before the renderer's signal listener.
    const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const
    for (const signal of signals) process.prependListener(signal, quit)
    return () => {
      for (const signal of signals) process.removeListener(signal, quit)
    }
  }, [quit])

  const startTurn = useCallback((prompt: string) => {
    const steering = Steering.make()
    const steered: Array<string> = []
    const startedAt = Date.now()
    const estimate = `turn:${writer.current.file}:${startedAt}`
    let tokens: number | undefined
    estimator.request({ id: estimate, kind: "turn", key: `turn:${live.current.seat}`, subject: prompt, startedAt })
    writer.current.append({ type: "user", at: startedAt, text: prompt })
    setTranscript((current) => Transcript.user(current, prompt, false, startedAt))
    const handle = props.host.run({
      prompt,
      seat: live.current.seat,
      history: entries.current,
      ...(live.current.seat.startsWith("replay:") ? {} : { role: "coordinator" as const }),
      workerSeat: props.workerSeat ?? props.seat,
      background: `${workspace.context()}\nFlow runs: ${runs.context()}\nMonitors: ${monitors.context()}\nAgents: ${
        Agents.context(runs.listed())
      }`,
      runtime: {
        publish: (contribution) => {
          if (contribution.kind !== "panel") return contribute("runtime:chat", contribution)
          if (contribution.placement === "tab") {
            const first = !workspace.snapshot().panels.some((shown) => shown.id === contribution.panel.id)
            const panel = workspace.publish(contribution.panel)
            if (first && panel.placement === "main") {
              setSurface((current) => current === "chat" ? `ui:${panel.id}` : current)
              setPanelFocus(false)
            }
            return
          }
          const at = Date.now()
          const panel = workspace.publish(contribution.panel, "card", at)
          setTranscript((current) => Transcript.card(current, panel, at))
        },
        delegate: workspace.request,
        read: (id) => (runs.has(id) ? runs.read(id) : workspace.read(id)),
        list: () => [...workspace.snapshot().tabs, ...runs.snapshot()],
        retry: (id) => (runs.has(id) ? runs.retry(id) : workspace.retry(id)),
        monitors,
        eta: () => estimator.eta(Estimate.active(workspace.snapshot().tabs, runs.snapshot()), Date.now(), seats),
        ...(props.flows === undefined ? {} : {
          flows: {
            list: () => runs.describe((flow) => flow.modelInvocable),
            run: (request: { id: string; flow: string; input?: Record<string, unknown> }) =>
              runs.request({ id: request.id, flow: request.flow, input: request.input ?? {}, by: "agent" }),
            inspect: runs.read
          }
        })
      },
      onCaption: (prose) => {
        writer.current.append({ type: "caption", prose })
        setTranscript((current) => Transcript.caption(current, prose))
      },
      onPatch: (receipt) => {
        writer.current.append({ type: "patch", receipt })
        setTranscript((current) => Transcript.patched(current, receipt))
      },
      steering: steering.source,
      ...(live.current.thinking === undefined ? {} : { thinking: live.current.thinking }),
      onEvent: (event) => {
        const at = Date.now()
        if (event._tag !== "model-delta") writer.current.append({ type: "event", at, event })
        if (event._tag === "model-settled") {
          tokens = (tokens ?? 0) + (Estimate.usage([{ type: "event", at, event }]) ?? 0)
        }
        if (event._tag === "steering-drained") {
          for (const message of event.messages) {
            steered.push(message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""))
          }
        }
        setTranscript((current) => Transcript.apply(current, event, at))
      }
    })
    const state: TurnState = { handle, startedAt, steering, estimate }
    live.current.turn = state
    setTurn(state)
    void handle.done.then((outcome) => {
      const at = Date.now()
      const said = [prompt, ...steered].join("\n\n")
      writer.current.append({ type: "outcome", at, prompt: said, outcome })
      estimator.settle(estimate, { ms: at - startedAt, ...(tokens === undefined ? {} : { tokens }) }, outcome._tag, at)
      if (outcome._tag === "done") entries.current.push({ kind: "exchange", user: said, answer: outcome.answer })
      if (outcome._tag === "failed") setTranscript((current) => Transcript.failure(current, outcome.message, at))
      if (outcome._tag === "cancelled") setTranscript((current) => Transcript.failure(current, "Stopped", at))
      live.current.turn = undefined
      setTurn(undefined)
      if (outcome._tag === "cancelled") return
      // Steers no boundary reached, then follow-ups, go next, one turn each.
      const undelivered = steering.take()
      const next = undelivered.length > 0 ? undelivered.join("\n\n") : dequeue()
      if (next !== undefined) startTurnRef.current(next)
    })
  }, [props.host, props.flows, workspace, runs, monitors, estimator, contribute, dequeue])
  const startTurnRef = useRef(startTurn)
  startTurnRef.current = startTurn

  const runShell = useCallback((command: string, excluded: boolean) => {
    if (live.current.shell !== undefined) {
      setStatus("A shell command is already running. Press esc to cancel it first.", "warning")
      return
    }
    let id = ""
    setTranscript((current) => {
      id = Transcript.nextId(current)
      return Transcript.shellStart(current, command, excluded, Date.now())
    })
    const running = Shell.run({
      command,
      cwd: props.host.cwd,
      onOutput: (text) => setTranscript((current) => Transcript.shellOutput(current, id, text))
    })
    // Claimed before the next render: a second `!cmd` or `/new` in the same input batch sees it.
    live.current.shell = running
    setShell(running)
    void running.done.then((result) => {
      writer.current.append({ type: "shell", at: Date.now(), result: Shell.persisted(result, excluded), excluded })
      if (!excluded) entries.current.push({ kind: "shell", text: Shell.contextText(result) })
      setTranscript((current) => Transcript.shellDone(current, id, result))
      if (live.current.shell === running) live.current.shell = undefined
      setShell((current) => (current === running ? undefined : current))
    })
  }, [props.host.cwd, setStatus])

  /** Reverses a Summary or worker tab row's captured changes in the background; the composer stays usable. */
  const runUndo = useCallback((target: Undo.Target, tab: string | undefined) => {
    const current = live.current
    if (
      current.turn !== undefined || current.shell !== undefined || current.undoing !== undefined || workspace.busy ||
      runs.busy
    ) {
      return setStatus(Undo.message({ _tag: "Busy" }), "warning")
    }
    const startedAt = Date.now()
    live.current.undoing = startedAt
    setUndoing(startedAt)
    const cwd = props.host.cwd
    void Undo.plan(cwd, target)
      .then((plan) => ("_tag" in plan ? plan : Undo.commit(cwd, plan).then((failure) => failure ?? plan)))
      .catch((error): Undo.Failure => ({ _tag: "WriteFailed", path: "", message: String(error), restored: false }))
      .then((settled) => {
        if ("_tag" in settled) {
          setStatus(
            Undo.message(settled),
            settled._tag === "Conflict" || settled._tag === "WriteFailed" ? "danger" : "warning"
          )
        } else {
          const at = Date.now()
          const paths = settled.files.map((file) => file.path)
          try {
            if (tab !== undefined) workspace.undone(tab, settled.calls, paths, at)
            writer.current.append({
              type: "undo",
              at,
              calls: settled.calls,
              paths,
              ...(tab === undefined ? {} : { tab })
            })
            entries.current.push({ kind: "undo", paths })
            if (tab === undefined) setTranscript((current) => Transcript.undone(current, settled.calls, paths, at))
            setStatus(Undo.done(settled))
          } catch (error) {
            setStatus(
              `${Undo.done(settled)} · not recorded: ${error instanceof Error ? error.message : String(error)}`,
              "danger"
            )
          }
        }
        live.current.undoing = undefined
        setUndoing(undefined)
        // A prompt sent while undoing waited, so the model never races the undo's writes.
        const next = live.current.turn === undefined ? dequeue() : undefined
        if (next !== undefined) startTurnRef.current(next)
      })
  }, [props.host.cwd, workspace, runs, setStatus, dequeue])

  const switchSeat = useCallback((next: string) => {
    setSeat(next)
    setStatus(`Switched to ${props.models.find((model) => model.seat === next)?.label ?? next}`)
  }, [props.models, setStatus])

  /**
   * Switches the screen, context, workers and every per-session view state to
   * `next`, whose records are `records`. Prompt history carries over when
   * `records` has none (`/new`).
   */
  const adopt = useCallback((next: Session.Writer, records: ReadonlyArray<Session.Record>) => {
    const recovered = Session.recover(records)
    const state = Session.restore(recovered.records)
    writer.current = Session.guarded(next, unsaved)
    if (recovered.receipt !== undefined) writer.current.append(recovered.receipt)
    entries.current = state.entries
    if (records.length > 0) history.current = new Editor.History(state.prompts)
    const nextRuns = new FlowRuns({
      occupied: (id) => workspaceRef.current?.has(id) ?? false,
      port: props.flows,
      persist: writer.current.append,
      restored: state.flows
    })
    setRuns(nextRuns)
    // Agents list the next session's flows, before the render that would set this.
    runsRef.current = nextRuns
    // Everything below belongs to one session; none of it may leak into the next.
    changeForm(undefined)
    userRuns.current = new Set()
    formOpened.current = new Set()
    setQueue(state.queued)
    setFilter(Timeline.all)
    clearInspection()
    setNavigation(Panels.initial())
    setCompact(undefined)
    const nextWorkspace = makeWorkspace(state.workspace)
    workspaceRef.current = nextWorkspace
    setWorkspace(nextWorkspace)
    setMonitors(makeMonitors(nextWorkspace, nextRuns, writer.current.append, state.monitors))
    contributions.clearRuntime()
    for (const each of state.contributions) {
      try {
        contributions.runtime(each.owner, each.contribution)
      } catch { /* A key a newer built-in took stays off. */ }
    }
    setSurface("chat")
    setPanelFocus(false)
    setName(state.name)
    setTranscript(state.transcript)
    return state
  }, [props.flows, changeForm, unsaved, contribute, contributions, setQueue])

  const newSession = useCallback(() => {
    adopt(Session.create(props.host.cwd), [])
    setStatus("New session started")
  }, [adopt, props.host.cwd, setStatus])

  const openSession = useCallback((file: string) => {
    let records: ReadonlyArray<Session.Record>
    try {
      records = Session.load(file)
    } catch (error) {
      return setStatus(Session.quarantine(file, error), "danger")
    }
    const state = adopt(Session.reopen(file), records)
    setStatus(`Resumed ${state.name ?? basename(file)}`)
  }, [adopt, setStatus])

  const forkSession = useCallback((turn: Session.Turn) => {
    let result: Session.Fork
    try {
      result = Session.fork(writer.current.file, props.host.cwd, turn)
    } catch (error) {
      return setStatus(`Fork failed: ${error instanceof Error ? error.message : String(error)}`, "danger")
    }
    if (result._tag === "Stale") return setStatus("Session changed; fork again", "warning")
    adopt(result.writer, result.records)
    setText(result.text)
    setStatus("Forked to new session")
  }, [adopt, setText, setStatus, props.host.cwd])

  /** `/new`, `/resume` and `/fork` wait for a turn, a `!cmd`, an undo, workers and flow runs, from any door. */
  const occupied = () =>
    live.current.turn !== undefined || live.current.shell !== undefined || live.current.undoing !== undefined ||
    workspace.busy || runs.busy

  const command = useCallback((text: string): boolean => {
    const parsed = Editor.parseCommand(text)
    if (parsed === undefined) return false
    const { name: verb, argument } = parsed
    switch (verb) {
      case "summary":
        showTab("summary")
        return true
      case "smithers":
        runs.refresh()
        showTab(`ui:${Smithers.id}`)
        return true
      case "tabs":
        showTab(snapshot.tabs[0] === undefined ? "summary" : `tab:${snapshot.tabs[0].id}`)
        return true
      case "chat":
        setSurface("chat")
        setPanelFocus(false)
        return true
      case "filter":
        setSurface("chat")
        setPanelFocus(false)
        setPicker({ kind: "filter", query: "", selected: 0 })
        return true
      case "grep":
        setSurface("chat")
        setPanelFocus(false)
        setFilter((current) => ({ ...current, query: argument }))
        return true
      case "retry":
      case "stop":
        TabCommand.run(verb, argument, {
          flows: runs,
          workers: {
            has: (id) => workspace.snapshot().tabs.some((tab) => tab.id === id),
            retry: workspace.retry,
            cancel: workspace.cancel
          },
          pick: () => setPicker({ kind: "palette", query: "tab:", selected: 0 }),
          report: (message) => setStatus(message, "warning")
        })
        return true
      case "flows":
        runs.refresh()
        setPicker({ kind: "flows", query: "", selected: 0 })
        return true
      case "flow": {
        const space = argument.search(/\s/)
        const flow = space < 0 ? argument : argument.slice(0, space)
        if (flow === "") {
          runs.refresh()
          setPicker({ kind: "flows", query: "", selected: 0 })
          return true
        }
        const parsed = parseArgs(space < 0 ? "" : argument.slice(space + 1))
        if ("error" in parsed) {
          setStatus(parsed.error, "warning")
          return true
        }
        try {
          userRuns.current.add(runs.request({ flow, input: parsed.input, by: "user" }).id)
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), "warning")
        }
        return true
      }
      case "agent": {
        const space = argument.search(/\s/)
        const agent = space < 0 ? argument : argument.slice(0, space)
        const prompt = space < 0 ? "" : argument.slice(space + 1).trim()
        if (agent === "") {
          runs.refresh()
          setPicker({ kind: "agents", query: "", selected: 0 })
          return true
        }
        // The prompt is the agent's one field: without it, the composer asks for it.
        if (prompt === "") {
          setText(`/agent ${agent} `)
          return true
        }
        try {
          workspace.request({
            id: `${agent}-${Date.now().toString(36)}`,
            title: prompt.replace(/\s+/g, " ").slice(0, 60),
            prompt,
            agent,
            by: "user"
          })
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), "warning")
        }
        return true
      }
      case "ui": {
        const target = uiPanels.find((panel) => panel.id === argument) ?? uiPanels[0]
        if (target === undefined) setStatus("No custom views")
        else {
          showTab(`ui:${target.id}`)
        }
        return true
      }
      case "model":
        if (argument.includes(":")) switchSeat(argument)
        else setPicker({ kind: "model", query: argument, selected: 0 })
        return true
      case "theme":
        setPicker({ kind: "theme", query: "", selected: 0 })
        return true
      case "thinking": {
        const level = argument === "" || argument === "default" ? undefined : argument
        if (level !== undefined && !(Editor.thinkingLevels as ReadonlyArray<string>).includes(level)) {
          setStatus(`Thinking levels: default, ${Editor.thinkingLevels.join(", ")}`, "warning")
          return true
        }
        setThinking(level as Editor.Thinking)
        setStatus(`Thinking level: ${level ?? "default"}`)
        return true
      }
      case "new":
        if (occupied()) {
          setStatus("Stop running work first", "warning")
        } else newSession()
        return true
      case "resume":
        setPicker({ kind: "resume", query: "", selected: 0, sessions: Session.list(props.host.cwd) })
        return true
      case "fork": {
        if (occupied()) {
          setStatus("Stop running work first", "warning")
          return true
        }
        let turns: ReadonlyArray<Session.Turn>
        try {
          turns = existsSync(writer.current.file) ? Session.turns(Session.load(writer.current.file)) : []
        } catch (error) {
          setStatus(`Fork failed: ${error instanceof Error ? error.message : String(error)}`, "danger")
          return true
        }
        if (turns.length === 0) setStatus("No messages to fork from")
        else setPicker({ kind: "fork", query: "", selected: 0, turns })
        return true
      }
      case "session": {
        const usage = transcript.usage
        setTranscript((current) =>
          Transcript.note(
            current,
            `${writer.current.file}\n${Log.path()}\n${entries.current.length} exchanges · ↑${
              Editor.tokens(usage.input)
            } ↓${Editor.tokens(usage.output)} R${Editor.tokens(usage.cached)}`,
            Date.now()
          )
        )
        return true
      }
      case "compact": {
        if (live.current.turn !== undefined) {
          setStatus("Stop running work first", "warning")
          return true
        }
        const dropped = Context.compactable(entries.current, compact ?? Math.round(transcript.usage.context / 2))
        if (dropped === 0) {
          setStatus("Nothing to compact")
          return true
        }
        entries.current.splice(0, dropped)
        writer.current.append({ type: "compact", at: Date.now(), dropped })
        setCompact(undefined)
        setStatus(`Dropped the ${dropped} oldest context entries`)
        return true
      }
      case "name":
        if (argument === "") {
          setStatus(name === undefined ? "This session has no name" : `Session: ${name}`)
          return true
        }
        writer.current.append({ type: "name", name: argument })
        setName(argument)
        return true
      case "copy": {
        const answer = transcript.items.findLast((item) => item.kind === "answer")
        if (answer === undefined || answer.kind !== "answer") {
          setStatus("No answer to copy", "warning")
          return true
        }
        void Clipboard.write(answer.text, Clipboard.commands(process.platform, process.env)).then((copied) =>
          copied
            ? setStatus("Copied the last answer")
            : setStatus("Copy failed: no pbcopy, wl-copy, xclip or xsel", "warning")
        )
        return true
      }
      case "hotkeys":
        setTranscript((current) => Transcript.note(current, Keys.sheet(), Date.now()))
        return true
      case "quit":
      case "exit":
        quit()
        return true
      default:
        setStatus(`Unknown command /${verb}`, "warning")
        return true
    }
  }, [transcript, name, newSession, quit, switchSeat, setStatus, setText, props.host.cwd, workspace, runs, revision])

  /** A prompt for the agent, taken literally: never a `!` shell line or a `/` command. */
  const send = useCallback((text: string, followUp = false) => {
    const running = live.current.turn
    if (running === undefined && live.current.undoing !== undefined) return enqueue(text)
    if (running === undefined) return startTurn(text)
    if (followUp) return enqueue(text)
    running.steering.steer(text)
    writer.current.append({ type: "user", at: Date.now(), text, steered: true })
    setTranscript((current) => Transcript.user(current, text, true, Date.now()))
  }, [startTurn, enqueue])

  const submit = useCallback((followUp = false, typed?: string) => {
    const input = composer.current
    if (input === null) return
    const text = (typed ?? input.plainText).trim()
    if (text === "") return
    clearFailure()
    const parked = parkedDraft.current
    parkedDraft.current = undefined
    history.current.add(text)
    setText(parked ?? "")
    const steering = live.current.steered
    const route = Composer.route(text, steering !== undefined)
    if (route._tag === "steer") {
      if (!workspace.steer(steering!.id, text)) setStatus(`${steering!.title} is not running`, "warning")
      return
    }
    if (route._tag === "shell") {
      if (route.command !== "") runShell(route.command, route.excluded)
      return
    }
    if (route._tag === "command" && command(text)) return
    send(text, followUp)
  }, [setText, runShell, command, send, workspace, setStatus])

  /**
   * Runs a contributed action for the person who chose it: a key, a status
   * item, a card row or a palette row. It never awaits: a prompt starts a turn
   * or queues, a flow returns its `requested` receipt, and the toast settles
   * with the run.
   */
  const perform = (action: Extension.Action) => {
    switch (action.kind) {
      case "prompt":
        setPanelFocus(false)
        if (live.current.turn === undefined && live.current.undoing === undefined) {
          return startTurnRef.current(action.prompt)
        }
        return enqueue(action.prompt)
      case "flow":
        try {
          userRuns.current.add(runs.request({ flow: action.flow, input: action.input ?? {}, by: "user" }).id)
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), "warning")
        }
        return
      case "agent":
        // Agent input is a form whose one field is the prompt: without one, the composer asks.
        if (action.prompt !== undefined && action.prompt.trim() !== "") {
          command(`/agent ${action.agent} ${action.prompt}`)
          return
        }
        setPanelFocus(false)
        return setText(`/agent ${action.agent} `)
      case "open": {
        const target = action.surface === "smithers" ? `ui:${Smithers.id}` : action.surface
        const card = target.startsWith("ui:") && cardIds.has(target.slice(3))
        if (target !== "chat" && !card && !surfaces.some((each) => each.id === target)) {
          return setStatus(`No view ${target}`, "warning")
        }
        if (liveForm.current !== undefined) changeForm(undefined)
        return showTab(target)
      }
    }
  }
  const ownerOf = (id: string): string | undefined =>
    Surfaces.ownerOf(id, { run: runs.get, plugins: extensions.panels })

  /** pi's restore: queued messages go back into the editor, above the draft. */
  const restoreQueued = useCallback((extra: ReadonlyArray<string> = []) => {
    const queued = [...extra.map((text) => ({ text })), ...live.current.followUps]
    if (queued.length === 0) return
    const at = Date.now()
    for (const each of live.current.followUps) {
      writer.current.append({ type: "dequeued", at, id: each.id, reason: "restored" })
    }
    setQueue([])
    const current = composer.current?.plainText ?? ""
    setText(PromptQueue.restoreDraft(queued, current))
    setStatus(`Restored ${queued.length} queued message${queued.length === 1 ? "" : "s"} to editor`)
  }, [setText, setStatus, setQueue])

  const cycleModel = useCallback((step: number) => {
    if (props.models.length < 2) {
      setStatus("Only one model available", "warning")
      return
    }
    const at = props.models.findIndex((model) => model.seat === live.current.seat)
    const next = props.models[(at + step + props.models.length) % props.models.length]!
    switchSeat(next.seat)
  }, [props.models, switchSeat, setStatus])

  const resumeGuarded = (file: string) => {
    if (!occupied()) openSession(file)
    else setStatus("Stop running work first", "warning")
  }

  const pick = useCallback((open: Picker, value: string) => {
    if (open.kind === "filter") {
      // Toggles keep the dialog open, like a log view's filter menu.
      if (value === "all") return setFilter(Timeline.all)
      const split = value.indexOf(":")
      const id = value.slice(split + 1)
      return setFilter((current) =>
        value.startsWith("source:")
          ? Timeline.toggleSource(current, id)
          : Timeline.toggleKind(current, id as Timeline.Kind)
      )
    }
    setPicker(undefined)
    if (open.kind === "undo") {
      if (value === "undo") runUndo(open.target, open.tab)
      return
    }
    if (open.kind === "fork") {
      const turn = open.turns.find((each) => String(each.index) === value)
      if (turn === undefined) return
      if (occupied()) {
        return setStatus("Stop running work first", "warning")
      }
      return forkSession(turn)
    }
    if (open.kind === "model") return switchSeat(value)
    if (open.kind === "worker-model") return workspace.retry(open.id, value)
    if (open.kind === "flows") {
      // An agent runs in a worker tab; its one field is the prompt.
      if (runs.listed().some((flow) => flow.name === value && Extension.isAgent(flow))) {
        return setText(`/agent ${value} `)
      }
      command(`/flow ${value}`)
      return
    }
    if (open.kind === "agents") return setText(`/agent ${value} `)
    if (open.kind === "theme") {
      if (!isTheme(value)) return
      setTheme(value)
      refreshTheme((count) => count + 1)
      try {
        saveTheme(value)
      } catch {
        setStatus("Could not save theme", "warning")
      }
      return
    }
    if (open.kind === "palette") {
      const chosen = JSON.parse(value) as Palette.Value
      switch (chosen.kind) {
        case "file":
        case "hit": {
          const input = composer.current
          if (input === null) return
          const next = Palette.insertAt(
            input.plainText,
            Cursor.index(input),
            Palette.mention(chosen.path, chosen.kind === "hit" ? chosen.line : undefined)
          )
          setPanelFocus(false)
          return setText(next.text, next.cursor)
        }
        case "command": {
          const found = Editor.commands.find((each) => each.name === chosen.name)
          if (found !== undefined && Editor.takesArgument(found)) {
            // The command takes the composer; the draft comes back on the next submit.
            const draft = composer.current?.plainText ?? ""
            if (draft.trim() !== "") parkedDraft.current = draft
            setPanelFocus(false)
            return setText(`/${chosen.name} `)
          }
          // Run it beside the draft, never through the composer or its history.
          command(`/${chosen.name}`)
          return
        }
        case "session":
          return resumeGuarded(chosen.file)
        case "tab":
          showTab(`tab:${chosen.id}`)
          return
        case "prefix":
          return setPicker({ kind: "palette", query: chosen.prefix, selected: 0 })
        case "action":
          return perform(chosen.action)
      }
    }
    resumeGuarded(value)
  }, [switchSeat, openSession, forkSession, runUndo, setStatus, workspace, runs, setText, command])

  /** Which keys act right now, in the order `handleKey` tries them. */
  const keyContext = (): Keys.KeyContext =>
    Dispatch.context({
      picker: live.current.picker !== undefined,
      inspecting: activeInspection !== undefined,
      form: liveForm.current !== undefined,
      approvals: live.current.approvals.length > 0,
      empty: composer.current?.plainText === "",
      panel: panelFocus && panel !== undefined,
      completion: liveMenu().menu !== undefined,
      card: focusedCard !== undefined,
      shell: live.current.shell !== undefined || composer.current?.plainText.startsWith("!") === true,
      turn: live.current.turn !== undefined
    })

  /** Undoes a Summary or worker tab row's changes after the confirm dialog. */
  const undoRow = (row: Panels.Row | undefined, tab: string | undefined) => {
    const current = live.current
    if (
      current.turn !== undefined || current.shell !== undefined || current.undoing !== undefined || workspace.busy ||
      runs.busy
    ) {
      return setStatus(Undo.message({ _tag: "Busy" }), "warning")
    }
    const found = row === undefined
      ? { _tag: "NothingToUndo" as const }
      : Undo.target(tab === undefined ? transcript : workspace.transcript(tab), row.id)
    if ("_tag" in found) {
      return setStatus(
        Undo.message(found),
        found._tag === "NothingToUndo" || found._tag === "AlreadyUndone" ? "warning" : "danger"
      )
    }
    return setPicker({ kind: "undo", query: "", selected: 0, target: found, ...(tab === undefined ? {} : { tab }) })
  }

  const handleKey = (key: KeyEvent): void => {
    const { turn: running, shell: shellRunning, picker: open } = live.current
    const { menu: completing, index: completingIndex } = liveMenu()
    const text = composer.current?.plainText ?? ""
    if (key.ctrl && key.name === "o" && timeline.length === 0 && surface === "chat" && open === undefined) {
      key.preventDefault()
      return setWhichKeyOpen(!whichKeyRef.current)
    }
    if (whichKeyRef.current) {
      if (
        Dispatch.whichKeyKey(key, Keys.bindingFor(key, keyContext(), merged), {
          close: () => setWhichKeyOpen(false),
          type: setText,
          scroll: (direction) => keyScroll.current?.scrollBy(direction * 0.75, "viewport")
        })
      ) return
    } else if (key.name === "?" && text === "" && open === undefined && liveForm.current === undefined) {
      key.preventDefault()
      return setWhichKeyOpen(true)
    }
    if (key.ctrl && key.name === "t" && showActivity && monitored !== undefined && open === undefined) {
      key.preventDefault()
      if (activeInspection !== undefined) followLive()
      else inspectActivity(monitored.activity.records.at(-1)!.sequence!, false)
      return
    }
    if (
      activeInspection !== undefined && monitored !== undefined && open === undefined &&
      Dispatch.scrubberKey(key, monitored.activity, activeInspection.seq, {
        follow: followLive,
        inspect: inspectActivity
      })
    ) return
    if (focusedCard !== undefined && open === undefined && !key.ctrl && !key.meta && !key.option) {
      if (
        Dispatch.cardKey(key, focusedCard, cardKeys, {
          focus: setCardFocus,
          reveal,
          open: () => {
            const row = timeline.find((each) => each.key === focusedCard)
            if (row?.item.kind !== "card") return
            const id = row.item.panel.id
            perform({ kind: "open", surface: id.startsWith("flow:") ? id : `ui:${id}` })
          }
        })
      ) return
    } else if (
      key.name === "tab" && !key.shift && !key.ctrl && !key.meta && !key.option && text === "" &&
      open === undefined && completing === undefined && liveForm.current === undefined && cardKeys.length > 0 &&
      keyContext() === "composer"
    ) {
      key.preventDefault()
      const last = cardKeys.at(-1)!
      setCardFocus(last)
      return reveal(last)
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      const at = Date.now()
      if (at - lastCtrlC.current < Editor.exitWindowMs) return quit()
      lastCtrlC.current = at
      flushSync(() => {
        if (open !== undefined) setPicker(undefined)
        setPanelFocus(false)
        setCardFocus(undefined)
        setText("")
      })
      return
    }
    const filling = liveForm.current
    if (filling !== undefined && open === undefined) {
      // Palette, summary and tab switching still work: they close the form and leave the run parked.
      if (!(key.ctrl && ["k", "s", "left", "right", "]", "\\"].includes(key.name))) {
        return Dispatch.formKey(key, filling, {
          // Retarget the native input before later bytes in the same terminal
          // read arrive. Advancing only the ref leaves typing on the old field.
          change: (next) => flushSync(() => changeForm(next)),
          schema: runs.schema,
          input: (id) => runs.get(id)?.input,
          fill: runs.fill
        })
      }
      changeForm(undefined)
    }
    if (key.ctrl && key.name === "k") {
      // Also keeps the composer's default Ctrl+K (delete to line end) from firing.
      key.preventDefault()
      const next: Picker | undefined = open?.kind === "palette"
        ? undefined
        : { kind: "palette", query: "", selected: 0 }
      // Move native focus before subsequent bytes in the same terminal read.
      flushSync(() => setPicker(next))
      return
    }
    if (key.ctrl && key.name === "s") {
      key.preventDefault()
      flushSync(() => {
        if (!focusMain) setSurface(surface === "chat" ? "summary" : surface)
        setPanelFocus(!panelFocus)
      })
      return
    }
    if (focusMain && key.ctrl && key.name === "\\") {
      key.preventDefault()
      flushSync(() => showTab("chat"))
      return
    }
    if (
      (key.ctrl && ["right", "left", "]", "\\"].includes(key.name)) || (key.name === "tab" && panelFocus && !key.shift)
    ) {
      key.preventDefault()
      flushSync(() => stepTab(surfaces, key.name === "left" || key.name === "\\"))
      return
    }
    // Contributed keys never shadow a built-in one (`Contributions` refused those), and a
    // panel key works only on its owner's own view.
    const contributed = open === undefined && liveForm.current === undefined
      ? Keys.bindingFor(key, keyContext(), merged)
      : undefined
    if (
      contributed?.action !== undefined && (contributed.context !== "panel" || ownerOf(surface) === contributed.owner)
    ) {
      key.preventDefault()
      return perform(contributed.action)
    }
    const choice = Approvals.key(key.name, {
      draft: text,
      shift: key.shift,
      ctrl: key.ctrl,
      meta: key.meta || key.option,
      armed: open === undefined &&
        Approvals.armed(arming.current, live.current.approvals[0]?.requestId, live.current.now),
      pending: live.current.approvals,
      reserved: panelKeys
    })
    if (choice !== undefined && props.host.approvals !== undefined) {
      key.preventDefault()
      const [first, ...rest] = live.current.approvals
      const requestId = first!.requestId
      answered.current.add(requestId)
      arming.current = Approvals.answered(requestId)
      live.current.approvals = rest
      setApprovals(rest)
      // A refused answer leaves the call waiting: show its row again.
      const retry = (code: string) => {
        answered.current.delete(requestId)
        arming.current = Approvals.failed(arming.current, requestId)
        setStatus(`Approval failed: ${code}`, "warning")
      }
      props.host.approvals.reply(first!, choice).then(
        (code) => code === undefined ? undefined : retry(code),
        (error) => retry(String(error))
      )
      return
    }
    if (panelFocus && panel !== undefined && open === undefined && !key.ctrl && !key.meta && !key.option) {
      return Dispatch.panelKey(key, panel, { surface, navigation, worker: workerTab, flow: selectedFlowActions }, {
        close: () =>
          flushSync(() => {
            setSurface("chat")
            setPanelFocus(false)
          }),
        release: () => flushSync(() => setPanelFocus(false)),
        retryRun: (id) => {
          try {
            runs.retry(id)
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error), "warning")
          }
        },
        cancelRun: runs.cancel,
        fillRun: (id) => flushSync(() => openForm(id)),
        undo: undoRow,
        workerAction,
        scroll: (direction) => panelScroll.current?.(direction),
        navigate: setNavigation,
        send: (prompt) => send(prompt),
        perform
      })
    }
    if (open !== undefined) {
      return Dispatch.dialogKey(key, open, { rows: rows.length, composerFocused: composer.current?.focused === true }, {
        close: () => flushSync(() => setPicker(undefined)),
        select: (update) =>
          flushSync(() =>
            setPicker((current) => current === undefined ? current : { ...current, selected: update(current.selected) })
          ),
        type: (typed) =>
          flushSync(() =>
            setPicker((current) =>
              current === undefined || current.kind === "undo"
                ? current
                : { ...current, query: current.query + typed, selected: 0 }
            )
          ),
        pick: (index) => {
          const row = rows[index]
          if (row !== undefined) flushSync(() => pick(open, row.value))
        }
      })
    }
    if (
      completing !== undefined && Dispatch.menuKey(key, completing, {
        select: setMenuIndex,
        dismiss: dismissMenu,
        accept: (run) => accept(completing, completingIndex, run, (typed) => submit(false, typed))
      })
    ) return
    Dispatch.composerKey(key, {
      text,
      steering: live.current.steered !== undefined,
      turn: running === undefined ? undefined : {
        stop: () => {
          restoreQueued(running.steering.take())
          running.handle.cancel()
        }
      },
      shell: shellRunning,
      history: history.current,
      scroll: scroll.current
    }, {
      stopSteering: () => {
        setSteerTarget(undefined)
        setPanelFocus(true)
      },
      setText: (next) => setText(next),
      quit,
      submit: (followUp) => submit(followUp),
      restoreQueued: () => restoreQueued(),
      nextThinking: () => {
        const next = Editor.nextThinking(live.current.thinking)
        setThinking(next)
        setStatus(`Thinking level: ${next ?? "default"}`)
      },
      pickModel: () => flushSync(() => setPicker({ kind: "model", query: "", selected: 0 })),
      cycleModel,
      toggleExpanded: () => setExpanded((value) => !value),
      externalEditor: () => void externalEditor(renderer, setStatus)
    })
  }

  useKeyboard(handleKey)

  const working = turn !== undefined
  const model = props.models.find((each) => each.seat === seat)
  const label = model?.label ?? (seat.startsWith("replay:") ? `replay ${basename(seat)}` : seat)
  const bashMode = draft.startsWith("!")
  const window = props.contextWindow(seat)
  useEffect(() => {
    let active = true
    setCompact(undefined)
    void props.host.compaction(transcript.usage.context, window).then((amount) => {
      if (active) setCompact(amount)
    })
    return () => {
      active = false
    }
  }, [props.host, transcript.usage.context, window, writer.current.file])
  const activeTabs = snapshot.tabs.filter((tab) => Tabs.live(tab.status))
  const sideChat = focusMain && dimensions.width >= 120
  const chatHeight = focusMain && !sideChat ? Math.floor(dimensions.height * 0.55) : dimensions.height
  const short = chatHeight < 20
  const showSidebar = dimensions.width >= 100 && activeTabs.length > 0 && (!focusMain || sideChat)
  const width = sideChat ? 40 : Math.max(20, Math.min(columnWidth, dimensions.width - 2 - (showSidebar ? 26 : 0)))
  const mainWidth = Math.max(20, dimensions.width - width - (showSidebar ? 26 : 0) - 2)
  const accent = bashMode
    ? color.success
    : steered !== undefined
    ? lanes.get(steered.id)?.tone ?? color.info
    : working
    ? color.faint
    : color.brand
  const tabsWidth = width - (focusMain ? 6 : 0)
  const footerContext = keyContext()
  // A worker's own actions are buttons in its view; the footer carries the rest.
  const footerHints = footerContext === "panel" && workerTab !== undefined
    ? Keys.panelHints({ undo: true }).filter((binding) => binding.id !== "expand-row")
    : footerContext === "panel" && panel !== undefined
    ? [
      ...Keys.panelHints({
        ...selectedFlowActions,
        undo: surface === "summary" || surface.startsWith("tab:"),
        action: panel.rows[Math.max(0, Math.min(navigation.selected, panel.rows.length - 1))]?.action?.label
      }),
      // A contributed panel key works only on its owner's view; a global one works here too.
      ...Keys.hintsFor("panel", merged).filter((binding) =>
        binding.owner !== undefined && (binding.context !== "panel" || binding.owner === ownerOf(surface))
      )
    ]
    : Keys.hintsFor(footerContext, merged)
  const meter = AppView.meter(transcript, window, compact)
  // The hints get the row less its padding, the margins, the status items and the meter; the path gives way first.
  const hintColumns = width - 5 -
    statusItems.reduce((total, item) => total + stringWidth(item.text) + 2, 0) -
    stringWidth(meter.context + meter.usage + meter.window)
  const toastRows = Toasts.rows({ tabs: snapshot.tabs, runs: flowRuns, approvals, search, undoing, toast, now, tick })
  const toastWidth = Math.min(60, mainWidth - 2)
  const toastHeight = Math.min(Math.floor(dimensions.height / 2), Math.max(1, toastRows.length * 3))
  const toastLimit = Math.max(1, Math.floor(chatHeight / 4))
  const formHeight = Math.max(
    3,
    chatHeight - (short ? 2 : 4) -
      Math.min(toastLimit, toastRows.length * (short ? 1 : 2)) -
      (followUps.length === 0 ? 0 : (short ? 3 : followUps.length + 2))
  )

  return (
    <box style={{ width: "100%", height: "100%", alignItems: "center" }} backgroundColor={color.page} {...dragScroll}>
      <box
        style={{
          flexDirection: focusMain && !sideChat ? "column" : "row",
          width: "100%",
          height: "100%",
          justifyContent: "center"
        }}
      >
        {showSidebar ?
          (
            <box style={{ width: 24, marginRight: 2, paddingTop: 3, flexDirection: "column", flexShrink: 0 }}>
              <WorkerList
                tabs={activeTabs.map((tab) => ({ ...tab, title: tabTitle(tab) }))}
                active={surface}
                models={props.models}
                now={now}
                tick={tick}
                eta={tabEta}
                onSelect={clickTab}
              />
            </box>
          ) :
          null}
        {focusMain && panel !== undefined ?
          (
            <box
              style={{
                flexDirection: "column",
                width: sideChat ? mainWidth : "100%",
                height: sideChat ? "100%" : "45%",
                paddingTop: 1,
                paddingLeft: 1,
                flexShrink: 0
              }}
            >
              <text fg={color.brand} style={{ marginBottom: 1 }}>{panel.title}</text>
              <PanelView
                panel={panel}
                navigation={navigation}
                height={sideChat ? dimensions.height - 4 : Math.floor(dimensions.height * 0.45) - 3}
                width={sideChat ? mainWidth : dimensions.width - 2}
                scrollRef={panelScroll}
              />
            </box>
          ) :
          null}
        <box
          style={{
            flexDirection: "column",
            height: focusMain && !sideChat ? "55%" : "100%",
            width,
            paddingTop: short ? 0 : 1
          }}
        >
          <box style={{ flexDirection: "row", flexShrink: 0, marginBottom: short ? 0 : 1, width }}>
            {focusMain ? <text fg={color.brand} style={{ flexShrink: 0 }}>Chat{"  "}</text> : null}
            {(() => {
              const note = Timeline.active(filter) && surface === "chat"
                ? filter.query === "" ? " filtered" : ` grep ${filter.query}`
                : ""
              return (
                <>
                  <TabStrip chips={surfaces} active={surface} width={tabsWidth - note.length} onSelect={clickTab} />
                  {note === ""
                    ? null
                    : <text fg={color.warning} wrapMode="none" style={{ flexShrink: 0 }}>{note}</text>}
                </>
              )
            })()}
          </box>
          {workerTab !== undefined && !focusMain ?
            (
              <WorkerView
                tab={{ ...workerTab, title: tabTitle(workerTab) }}
                transcript={workspace.transcript(workerTab.id)}
                models={props.models}
                now={now}
                tick={tick}
                tone={lanes.get(workerTab.id)?.tone ?? color.info}
                width={width}
                expanded={expanded}
                onAction={(action) => workerAction(workerTab, action)}
                selected={panel?.rows[Math.min(navigation.selected, panel.rows.length - 1)]?.id}
                scrollRef={panelScroll}
              />
            ) :
            panel !== undefined && !focusMain ?
            (
              <>
                <PanelView
                  panel={panel}
                  navigation={navigation}
                  height={dimensions.height - 10}
                  width={width}
                  scrollRef={panelScroll}
                  hideSummary={surface.startsWith("tab:") &&
                    snapshot.tabs.some((tab) => tab.id === surface.slice(4) && tab.status === "failed")}
                />
              </>
            ) :
            timeline.length === 0 && !Timeline.active(filter)
            ? form === undefined ? <View.Home width={width} /> : <box style={{ flexGrow: 1, minHeight: 0 }} />
            : (
              <scrollbox
                ref={scroll}
                stickyScroll
                stickyStart="bottom"
                style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, scrollbarOptions: { visible: false } }}
              >
                {timeline.map((row, index) => {
                  const worker = lanes.get(row.source)
                  const card = row.item.kind === "card" ? livePanel(row.item.panel) : undefined
                  const step = row.item.kind === "cell" ? Scrubber.step(transcriptOf(row.source), row.item) : undefined
                  const entry = card !== undefined
                    ? (
                      <View.Card
                        panel={card}
                        focused={row.key === focusedCard}
                        onOpen={() =>
                          perform({ kind: "open", surface: card.id.startsWith("flow:") ? card.id : `ui:${card.id}` })}
                      />
                    )
                    : (
                      <View.Entry
                        item={row.item}
                        now={View.ticking(row.item) ? now : 0}
                        tick={View.ticking(row.item) ? tick : ""}
                        expanded={expanded}
                        selected={row.key === jumpTarget}
                        {...(step === undefined ? {} : { step })}
                        {...(worker === undefined ? {} : { tone: worker.tone })}
                      />
                    )
                  return worker === undefined
                    ? <box key={row.key} id={row.key}>{entry}</box>
                    : (
                      <View.Lane
                        key={row.key}
                        id={row.key}
                        title={worker.title}
                        tone={worker.tone}
                        first={timeline[index - 1]?.source !== row.source}
                      >
                        {entry}
                      </View.Lane>
                    )
                })}
                {working && transcript.thinking
                  ? <text fg={color.muted} style={{ paddingLeft: 2 }}>{tick} thinking</text>
                  : null}
              </scrollbox>
            )}
          {!showActivity || monitored === undefined || (short && activeInspection === undefined) ?
            null :
            (
              <ActivityView
                activity={monitored.activity}
                width={width}
                now={now}
                title={monitored.title}
                focused={activeInspection !== undefined}
                cursor={activeInspection?.seq}
                onSelect={inspectActivity}
                onPause={() =>
                  activeInspection !== undefined
                    ? followLive()
                    : inspectActivity(monitored.activity.records.at(-1)!.sequence!, false)}
              />
            )}
          {followUps.length === 0 ? null : (
            <box style={{ marginTop: 1, paddingLeft: 2, flexShrink: 0 }}>
              {(short ? followUps.slice(-1) : followUps).map((prompt) => (
                <text key={prompt.id} fg={color.muted} wrapMode="none">
                  {short ? `${followUps.length} queued: ` : "Follow-up: "}
                  {prompt.text.split("\n")[0]}
                </text>
              ))}
              <text fg={color.faint} wrapMode="none">
                {short ? "alt+up Edit queue" : "↳ alt+up to edit all queued messages"}
              </text>
            </box>
          )}
          {form === undefined ? null : (
            <FlowFormView
              form={form}
              height={formHeight}
              compact={short}
              onField={(field, text) => {
                const current = liveForm.current
                if (current !== undefined) {
                  changeForm({ ...current, draft: { ...current.draft, [field]: text }, error: undefined })
                }
              }}
            />
          )}
          {menu === undefined || panelFocus || form !== undefined ?
            null :
            (
              <CompletionMenu
                menu={menu}
                selected={menuIndex}
                seat={seat}
                thinking={thinking}
                rows={short ? Math.max(1, Math.floor(chatHeight / 4)) : undefined}
              />
            )}
          {sideChat ? null : <View.ToastStack rows={toastRows} height={toastLimit} compact={short} />}
          {approvals[0] === undefined ? null : (
            <View.Approval
              width={dimensions.width}
              request={approvals[0]}
              scope={Approvals.scope(approvals[0])}
              all={!panelKeys.includes("a")}
              armed={picker === undefined && form === undefined &&
                Approvals.ready(arming.current, approvals[0].requestId, now, draft)}
              more={approvals.length - 1}
              {...(approvals[0].source === "chat"
                ? {}
                : {
                  worker: snapshot.tabs.find((tab) => tab.id === approvals[0]!.source)?.title ??
                    flowRuns.find((run) =>
                      `flow:${run.id}` === approvals[0]!.source
                    )?.flow ?? approvals[0].source
                })}
            />
          )}
          {form !== undefined ? null : (
            <box
              style={{ border: ["left"], marginTop: short ? 0 : 1, flexShrink: 0 }}
              borderColor={accent}
              customBorderChars={View.bar}
            >
              <box
                style={{ paddingLeft: 2, paddingRight: 2, paddingTop: short ? 0 : 1 }}
                backgroundColor={color.surface}
              >
                <textarea
                  ref={composer}
                  focused={picker === undefined && !panelFocus && form === undefined}
                  placeholder={steered !== undefined
                    ? ""
                    : working
                    ? "Steer, or alt+enter to queue"
                    : "Ask Smithers to change this repository"}
                  placeholderColor={color.faint}
                  textColor={color.text}
                  focusedTextColor={color.text}
                  backgroundColor={color.surface}
                  focusedBackgroundColor={color.surface}
                  cursorColor={color.brand}
                  keyBindings={Composer.keys}
                  onSubmit={() => submit(false)}
                  onContentChange={onContentChange}
                  onCursorChange={onCursorChange}
                  style={{
                    minHeight: 1,
                    maxHeight: short
                      ? Math.max(1, Math.floor(chatHeight / 4))
                      : Math.max(6, Math.floor(chatHeight / 3))
                  }}
                />
                <text wrapMode="none" style={{ marginTop: short ? 0 : 1, marginBottom: short ? 0 : 1 }}>
                  {bashMode || steered !== undefined
                    ? (
                      <>
                        <span fg={accent}>{bashMode ? "shell" : `steer ↳ ${steered!.title}`}</span>
                        <span fg={color.faint}>{"  ·  "}</span>
                      </>
                    )
                    : null}
                  <span fg={color.text}>{steered === undefined ? label : Tabs.model(steered.seat, props.models)}</span>
                  {model === undefined || steered !== undefined
                    ? null
                    : <span fg={color.faint}>{" "}{model.provider}</span>}
                  {thinking === undefined ? null : <span fg={color.warning}>{"  "}{thinking}</span>}
                </text>
              </box>
            </box>
          )}
          <StatusLine
            lead={working
              ? (
                <>
                  <span fg={color.brand}>{tick} {Transcript.duration(now - turn.startedAt)}</span>
                  <span fg={color.faint}>{eta(turn.estimate, "running", turn.startedAt)}</span>
                </>
              )
              : (
                <span fg={color.faint}>
                  {props.host.cwd.replace(homedir(), "~")}
                  {props.branch === undefined ? "" : ` (${props.branch})`}
                  {name === undefined ? "" : ` • ${name}`}
                </span>
              )}
            hints={Keys.fit(footerHints, hintColumns, stringWidth)}
            items={statusItems}
            onItem={(item) =>
              item.action === undefined ? undefined : perform(item.action)}
            meter={meter}
          />
        </box>
      </box>
      {whichKey
        ? (
          <View.KeyPopup
            scrollRef={keyScroll}
            bindings={Keys.bindingsFor(footerContext, merged)}
            width={dimensions.width}
            height={dimensions.height}
          />
        )
        : null}
      {sideChat && toastRows.length > 0
        ? (
          <box
            style={{
              position: "absolute",
              left: mainWidth - toastWidth,
              top: dimensions.height - toastHeight - 2,
              width: toastWidth,
              height: toastHeight
            }}
          >
            <View.ToastStack rows={toastRows} height={toastLimit} compact={short} />
          </box>
        )
        : null}
      {picker === undefined ? null : (
        <PickerDialog
          title={Pickers.title(picker, parsedPalette?.mode === "text" && search?.truncated === true)}
          query={picker.kind === "undo" ? undefined : picker.query}
          onQuery={(query) =>
            flushSync(() =>
              setPicker((
                current
              ) => (current === undefined || current.kind === "undo" ? current : { ...current, query, selected: 0 }))
            )}
          rows={rows}
          selected={picker.selected}
          empty={Pickers.empty(
            picker,
            () => runs.failure()?.message ?? (runs.opening ? "Opening flows" : "No flows"),
            search?.status === "running"
          )}
          width={Math.min(72, dimensions.width - 4)}
          height={dimensions.height}
        />
      )}
    </box>
  )
}
