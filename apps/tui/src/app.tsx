import * as PromptQueue from "@smthrs/rpc/PromptQueue"
import { useClock } from "@smthrs/ui/clock"
import { parseArgs } from "@smthrs/ui/flow-arguments"
import { NOTICE_SETTLE_MS } from "@smthrs/ui/notification-policy"
import * as Failures from "./failures.ts"
import * as Log from "./log.ts"
/**
 * The terminal UI: a transcript of cells above a composer.
 *
 * Keys and commands follow pi (`badlogic/pi-mono` coding-agent) wherever the
 * cell harness has the same idea; `editor.ts` lists them. `view.tsx` draws.
 */
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { flushSync, useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react"
import * as CloudSession from "@smthrs/cli/CloudSession"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import * as Form from "@smthrs/ui/flow-form"
import { Schema } from "effect"
import { basename } from "node:path"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityView } from "./activity-view.tsx"
import * as Agents from "./agents.ts"
import * as AppView from "./app-view.tsx"
import { CompletionMenu, FlowFormView, PickerDialog, StatusLine } from "./app-view.tsx"
import * as Approvals from "./approvals.ts"
import * as Asks from "./asks.ts"
import * as Budget from "./budget.ts"
import * as Catalog from "./catalog.ts"
import * as Clipboard from "./clipboard.ts"
import * as Composer from "./composer.ts"
import * as Context from "./context.ts"
import * as Contributions from "./contributions.ts"
import * as Cursor from "./cursor.ts"
import * as DevTools from "./devtools.ts"
import * as Editor from "./editor.ts"
import * as Extension from "./extension.ts"
import * as External from "./external.ts"
import * as Factory from "./factory.ts"
import * as Files from "./files.ts"
import {
  actions as flowActions,
  discoveryNotice,
  FlowRuns,
  type Port as FlowPort,
  type Run as FlowRun
} from "./flows.ts"
import * as Home from "./home.ts"
import type * as Host from "./host.ts"
import * as Inbox from "./inbox.ts"
import * as Dispatch from "./key-dispatch.ts"
import * as Keys from "./keys.ts"
import { settled } from "./lifecycle.ts"
import * as Models from "./models.ts"
import * as Monitors from "./monitors.ts"
import * as Palette from "./palette.ts"
import { PanelView } from "./panel-view.tsx"
import * as Panels from "./panels.ts"
import * as Pickers from "./picker.ts"
import { ReviewView } from "./review-view.tsx"
import * as Scrubber from "./scrubber.ts"
import * as Session from "./session.ts"
import * as Shell from "./shell.ts"
import * as Smithers from "./smithers.ts"
import * as Steering from "./steering.ts"
import * as SubagentView from "./subagent-view.tsx"
import * as Subagents from "./subagents.ts"
import * as Summary from "./summary.ts"
import * as Surfaces from "./surfaces.ts"
import { tabTitle } from "./surfaces.ts"
import { chip as workerChip, TabStrip, WorkerList, WorkerView } from "./tabs-view.tsx"
import * as Tabs from "./tabs.ts"
import type * as TargetApprovals from "./target-approvals.ts"
import { color, spinner } from "./theme.ts"
import * as Timeline from "./timeline.ts"
import * as Toasts from "./toasts.ts"
import * as TranscriptView from "./transcript-view.ts"
import * as Transcript from "./transcript.ts"
import * as Tree from "./tree.ts"
import * as Undo from "./undo.ts"
import * as View from "./view.tsx"
import * as Watch from "./watch.ts"
import { type Snapshot, type Tab, Workspace } from "./workspace.ts"

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
  /** Build targets waiting for approval in the workspace; absent where none can be read. */
  readonly targets?: TargetApprovals.Port
}

interface TurnState {
  readonly handle: Host.Turn
  readonly startedAt: number
  readonly steering: Steering.Queue
}

type Picker = Pickers.Picker

type FlowForm = Dispatch.FlowForm
/** A form's id prefix when it answers a worker's ask rather than filling a flow run. */
const askForm = "ask:"
/** A form's id prefix when it raises a capped worker's token cap. */
const capForm = "cap:"
/** The follow-up queue an agent tab's composer adds to, or the chat's. */
const queueScope = (tab: Tab | undefined) => tab === undefined ? "chat" : `tab:${tab.id}`

export function App(props: AppProps) {
  const renderer = useRenderer()
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
  const [seat, setSeat] = useState(props.seat)
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
  const confirmedStops = useRef(new Set<string>())
  const [expanded, setExpanded] = useState(false)
  const { toast, setStatus, clearFailure } = Toasts.useToast()
  const [name, setName] = useState(restored.current?.name)
  const [approvals, setApprovals] = useState<ReadonlyArray<Approvals.Pending>>([])
  const [targets, setTargets] = useState<ReadonlyArray<TargetApprovals.Row>>([])
  // Answered but maybe still listed: a poll can land before the store drops it.
  const answered = useRef(new Set<string>())
  // When the front row starts taking y, n and a; see `Approvals.Arming`.
  const arming = useRef(Approvals.idle)
  const entries = useRef<Array<Context.Entry>>(restored.current?.entries ?? [])
  // A record the disk refused never stops the screen: the row says what went unsaved.
  const unsaved = useCallback((failure: Session.WriteFailed) => {
    const text = Failures.line("session", failure)
    setStatus(text, "danger")
    setTranscript((current) => Transcript.alert(current, text, Date.now()))
  }, [])
  const durableWriter = useRef<Session.Writer>(
    restored.file === undefined ? Session.create(props.host.cwd) : Session.reopen(restored.file)
  )
  const writer = useRef<Session.Writer>(Session.guarded(durableWriter.current, unsaved))
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
  // Agents share the session's recent listing and read the current body at launch.
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
          listing: (options) => runsRef.current?.listing(options) ?? Promise.reject(new Error("Flows unavailable"))
        }, props.flows)
      }),
      seatOf: props.seatOf ?? ((declared) => Models.seatOf(declared, props.models)),
      delegable: Models.delegable(props.models),
      chatSeat: (): string => live.current.seat,
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
    showTab,
    stepTab
  } = Surfaces.useSurface()
  const [whichKey, setWhichKey] = useState(false)
  const whichKeyRef = useRef(false)
  const keyScroll = useRef<ScrollBoxRenderable | null>(null)
  const approvalScroll = useRef<ScrollBoxRenderable | null>(null)
  const setWhichKeyOpen = useCallback((open: boolean) => {
    whichKeyRef.current = open
    setWhichKey(open)
  }, [])
  const [filter, setFilter] = useState(Timeline.all)
  /** Workers whose card lists its changed files. */
  const [filesOpen, setFilesOpen] = useState<ReadonlySet<string>>(new Set())
  /** The worker whose run's diff shows full height, over the surface it was opened on. */
  const [review, setReview] = useState<{ readonly tab: string; readonly surface: string } | undefined>()
  const reviewScroll = useRef<((by: number, page: boolean) => void) | undefined>(undefined)
  const toggleFiles = (id: string) =>
    setFilesOpen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  /** The Summary overview: the tree's selection (`chat` or a worker), the pane with the keys, and the focused card. */
  const [overview, setOverview] = useState<
    {
      readonly selected?: string
      readonly pane: "tree" | "cards"
      readonly card?: string
      readonly peek?: boolean
      readonly graph?: boolean
      /** The Failed group shows its rows. */
      readonly failedOpen?: boolean
    }
  >({ pane: "tree" })
  /** The tab Ctrl+S opened the Summary from, for its way back; cleared once another tab shows. */
  const summaryFrom = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (surface !== "summary") summaryFrom.current = undefined
  }, [surface])
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
  /** Opens a run's form for its missing input. */
  const openForm = useCallback((id: string) => {
    const run = runs.get(id)
    if (run?.status !== "input") return
    const schema = runs.schema(id)
    const fields = schema === undefined ? [] : Form.formFieldsFor(schema)
    setPanelFocus(false)
    changeForm({ id, flow: run.flow, fields, draft: Form.draftFrom(fields, run.input, "json"), focus: 0 })
  }, [runs, changeForm])
  /**
   * A person's form closed, answered or not: the list or tab it came from takes the keys back,
   * unless the person went somewhere else.
   */
  const formReturn = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (form !== undefined || formReturn.current === undefined) return
    const from = formReturn.current
    formReturn.current = undefined
    if (from === surface) setPanelFocus(true)
  }, [form, surface, setPanelFocus])
  /**
   * Opens the answer form for a worker's ask the person holds: the whole question, then its choices.
   * `lead` is the chat key that opened it.
   */
  const openAsk = useCallback((tabId: string, lead?: string) => {
    const ask = workspace.asks.fromPerson(tabId)
    if (ask === undefined) return
    const title = workspace.snapshot().tabs.find((tab) => tab.id === tabId)?.title ?? tabId
    formReturn.current = panelFocus ? surface : undefined
    setPanelFocus(false)
    changeForm({
      id: `${askForm}${ask.id}`,
      flow: title,
      fields: [],
      draft: {},
      focus: 0,
      // A choice starts on its first option, so Enter alone answers it.
      ask: {
        question: ask.question,
        options: ask.options ?? [],
        choice: 0,
        armedAt: Date.now() + Approvals.armMs,
        ...(lead === undefined ? {} : { lead })
      }
    })
  }, [workspace, changeForm, panelFocus, surface])
  /** What the cap form offers a worker stopped at its run cap, and its schema; undefined for any other worker. */
  const capOffer = useCallback((tabId: string) => {
    const tab = workspace.snapshot().tabs.find((each) => each.id === tabId)
    const base = props.host.runCap
    if (tab?.status !== "failed" || !Budget.capped(tab.failure) || base === undefined) return undefined
    const labels = Budget.offers.map((times) => Budget.offer(base * times)) as [string, ...Array<string>]
    return { tab, offers: Budget.offers, labels, schema: Schema.Struct({ cap: Schema.Literals(labels) }) }
  }, [workspace, props.host])
  /** Opens the cap form for a worker stopped by a token cap. */
  const openCap = useCallback((tabId: string) => {
    const offer = capOffer(tabId)
    if (offer === undefined) return
    const fields = Form.formFieldsFor(offer.schema)
    formReturn.current = panelFocus ? surface : undefined
    setPanelFocus(false)
    changeForm({
      id: `${capForm}${tabId}`,
      flow: `● ${offer.tab.title} · ${offer.tab.failure!.line}`,
      fields,
      // Enter alone keeps at least the allowance the worker already had.
      draft: Form.draftFrom(fields, {
        cap: offer.labels[Math.max(0, offer.offers.findIndex((times) => times >= (offer.tab.caps?.times ?? 1)))]
      }, "json"),
      focus: 0
    })
  }, [capOffer, changeForm, panelFocus, surface])
  /** `a` on a worker: its ask, else its cap. */
  const answerWorker = useCallback((tabId: string) => {
    if (workspace.asks.fromPerson(tabId) !== undefined) openAsk(tabId)
    else openCap(tabId)
  }, [workspace, openAsk, openCap])
  useEffect(() => {
    const open = liveForm.current
    if (open !== undefined) {
      const capped = open.id.startsWith(capForm)
        ? workspace.snapshot().tabs.find((tab) => tab.id === open.id.slice(capForm.length))
        : undefined
      const live = open.id.startsWith(askForm)
        ? workspace.asks.get(open.id.slice(askForm.length))?.holder === Asks.person
        : open.id.startsWith(capForm)
        ? capped?.status === "failed" && Budget.capped(capped.failure)
        : runs.get(open.id)?.status === "input"
      // An explicitly opened worker form owns the keys while other calls await approval.
      if (!live || (approvals.length > 0 && !open.id.startsWith(askForm) && !open.id.startsWith(capForm))) {
        changeForm(undefined)
      }
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
  /** A flow run's card status, for its head glyph; a form waiting reads as waiting. */
  const cardStatus = (card: Panels.Panel): Panels.Row["status"] => {
    const status = card.id.startsWith("flow:") ? runs.get(card.id.slice(5))?.status : undefined
    return status === "input" ? "waiting" : status
  }
  const livePanel = (card: Panels.Panel): Panels.Panel =>
    snapshot.panels.find((each) => each.id === card.id) ??
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
  // A plugin's tab shows only while open: tab keys never stop on it (`/smithers` opens Smithers).
  const pluginPanels = uiPanels.filter((panel) =>
    extensions.panels.some((each) => each.placement === "tab" && each.panel === panel)
  )
  const pluginTabs = pluginPanels.filter((panel) => surface === `ui:${panel.id}`)
  // Built-in plugin: the Smithers surface, a `plugin:smithers` tab over the factory's issues and apps.
  const homeApps = useMemo(() => Home.read(props.host.cwd), [props.host.cwd])
  // The factory's issue list, read from Cloud as the signed-in person while the Smithers tab shows.
  const [factory, setFactory] = useState<Smithers.Factory | "signed-out" | undefined>()
  const factoryRepo = useMemo(() => Factory.repository(props.host.cwd, process.env), [props.host.cwd])
  // `/todo` files through the session it resolves; the filer keeps a request id per unanswered TODO.
  const todoCloud = useRef<CloudSession.Cloud | undefined>(undefined)
  const todoFiler = useRef(Factory.filer((path, body, signal) => todoCloud.current!.post(path, body, signal)))
  const factoryRetries = useRef(new Set<string>())
  const smithersShown = surface === `ui:${Smithers.id}`
  useEffect(() => {
    if (!smithersShown) return
    const controller = new AbortController()
    // One read at a time; a failed read clears the list rather than leaving it stale. The session is
    // resolved once (it may ask the keyring) and again only after Cloud refuses it.
    let reading = false
    let cloud: CloudSession.Cloud | undefined
    const read = async () => {
      if (reading || factoryRepo === undefined) return
      reading = true
      try {
        cloud ??= await CloudSession.signedIn(process.env)
        if (cloud === undefined) return setFactory("signed-out")
        const stack = await Factory.load(cloud.get, factoryRepo, controller.signal)
        if (!controller.signal.aborted) {
          setFactory({ metrics: Factory.metrics(stack), rows: Factory.rows(stack, Date.now()) })
        }
      } catch (error) {
        if (controller.signal.aborted) return
        const refused = CloudSession.isAuthenticationRefusal(error)
        if (refused) cloud = undefined
        setFactory(refused ? "signed-out" : undefined)
        Log.write("factory.read", error)
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 30_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [smithersShown, factoryRepo])
  const smithersPanel = homeApps.length === 0 && factoryRepo === undefined
    ? undefined
    : Smithers.panel(homeApps, new Set(runs.listed().map((flow) => flow.name)), factory)
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
  // A run the person started here, and each run of a `metadata.tui.card` flow, shows as a live card in the chat.
  const mountedAt = useRef(Date.now())
  const carded = useRef(new Set<string>())
  const cardFlows = extensions.cards.join("\n")
  useEffect(() => {
    for (const run of flowRuns) {
      if (
        run.startedAt < mountedAt.current || carded.current.has(run.id) ||
        !(userRuns.current.has(run.id) || extensions.cards.includes(run.flow))
      ) {
        continue
      }
      showRun(run.id, run.flow)
    }
  }, [revision, runs, cardFlows])
  const tick = spinner[Math.floor(now / 100) % spinner.length]!
  /**
   * The Summary overview shows while work exists: Needs you, Working, Failed and Done, then the selected
   * worker's cards.
   */
  const inbox = Inbox.rows({
    tabs: snapshot.tabs,
    runs: flowRuns,
    models: props.models,
    now,
    asks: workspace.asks.list(),
    approvals: approvals.map((request) => request.source).filter((source) => source !== "chat"),
    targets,
    monitors: monitors.list()
  })
  /** `◆N` beside Summary: what the person can answer now, the chat's own approvals included. */
  const needsCount = Inbox.count(inbox, approvals.filter((request) => request.source === "chat").length)
  /** The one thing waiting for the person, when it is an ask: `a` answers it from the chat. */
  const soleAsk = needsCount === 1 ? inbox.find((section) => section.group === "needs")?.rows[0]?.ask : undefined
  const surfaces = Surfaces.chips({
    active: surface,
    workspace: snapshot,
    runs: flowRuns,
    plugins: pluginTabs,
    views: uiPanels.filter((panel) => !pluginPanels.includes(panel)),
    worker: (tab) => workerChip({ ...tab, title: tabTitle(tab) }, now, workspace.asks.fromPerson(tab.id)),
    needs: needsCount
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
  /** The run whose diff shows; leaving the surface it was opened on closes it. */
  const reviewTab = review?.surface === surface ? snapshot.tabs.find((tab) => tab.id === review.tab) : undefined
  useEffect(() => {
    if (review !== undefined && review.surface !== surface) setReview(undefined)
  }, [surface, review])
  /** The follow-ups the shown composer queued: the chat's, or this agent's. */
  const shownQueue = PromptQueue.inScope(followUps, queueScope(workerTab))
  const continued = workerTab !== undefined &&
      (workerTab.status === "done" || workerTab.status === "failed" || workerTab.status === "cancelled")
    ? workerTab
    : undefined
  const selectedFlowActions = flowActions(surface.startsWith("flow:") ? runs.get(surface.slice(5)) : undefined)
  /** The composer addresses the agent whose tab is open. */
  const steered = workerTab !== undefined && workerTab.status === "running" &&
      workerTab.driver === undefined && workerTab.harness === undefined
    ? workerTab
    : undefined
  /** The worker the person drives from this tab (`t`): Enter runs its next frame. */
  // A wrapped worker is driven in its vendor's own TUI, never from the composer.
  const driven = workerTab?.driver !== undefined && workerTab.harness === undefined &&
      (workerTab.status === "running" || workerTab.status === "waiting")
    ? workerTab
    : undefined
  /** Suspends the TUI for a taken-over wrapped worker's own TUI, then hands the worker back. */
  const handOver = async (id: string) => {
    try {
      const { command, args } = await workspace.handedOver(id)
      await External.exclusive(async () => {
        renderer.suspend()
        try {
          const status = await External.run(command, args, props.host.cwd)
          if (status === 126 || status === 127) setStatus(`${command} not found`, "warning")
        } finally {
          renderer.resume()
          // Window changes went to the vendor while we were suspended.
          process.kill(process.pid, "SIGWINCH")
        }
      })
    } catch (error) {
      setStatus(Failures.line("command", error), "warning")
    } finally {
      workspace.release(id)
    }
  }
  // The session survives queue admission; a retry opens a new session or continuation.
  const workerRun = (tab: Tab) => tab.continuationId ?? tab.file
  const stopKey = (id: string, run: string) => JSON.stringify([id, run])
  const workerAction = (tab: Tab, action: Tabs.ActionId) => {
    switch (action) {
      case "stop":
        if (confirmedStops.current.has(stopKey(tab.id, workerRun(tab)))) return
        return flushSync(() =>
          setPicker({
            kind: "stop",
            id: tab.id,
            title: tab.title,
            run: workerRun(tab),
            query: "",
            selected: 0
          })
        )
      case "retry":
        try {
          workspace.retry(tab.id)
          return
        } catch (error) {
          return setStatus(Failures.line("retry", error), "warning")
        }
      case "model":
        return flushSync(() => setPicker({ kind: "worker-model", id: tab.id, query: "", selected: 0 }))
      case "wait":
        try {
          return workspace.waitForReset(tab.id)
        } catch (error) {
          return setStatus(Failures.line("wait", error), "warning")
        }
      case "steer":
        // From a card or a toast, steering opens the worker's tab first.
        return flushSync(() => {
          if (surface !== `tab:${tab.id}`) showTab(`tab:${tab.id}`)
          setPanelFocus(false)
        })
      case "raise":
        return flushSync(() => answerWorker(tab.id))
      case "takeover":
        // The composer drives it from its own tab; ctrl+y releases.
        if (!workspace.hijack(tab.id, "you")) {
          return setStatus(workspace.unsteerable(tab.id) ?? `${tab.title} is not running`, "warning")
        }
        // A wrapped worker is driven in its vendor's own TUI; quitting it hands the worker back.
        if (tab.harness !== undefined) return void handOver(tab.id)
        return flushSync(() => {
          if (surface !== `tab:${tab.id}`) showTab(`tab:${tab.id}`)
          setPanelFocus(false)
        })
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
  const summaryAction = () =>
    Surfaces.summaryKey({ surface, main: focusMain, from: summaryFrom.current, strip: surfaces })
  /** An agent's answer/cap chord and a focused panel's row action take precedence over allow-all. */
  const reservedApprovalKeys = workerTab !== undefined
    ? workspace.asks.fromPerson(workerTab.id) !== undefined || Tabs.actionFor("approve-form", workerTab) !== undefined
      ? ["a"]
      : []
    : panelFocus && panel !== undefined &&
        (surface.startsWith("flow:") || surface === "summary" ||
          panel.rows[Math.min(navigation.selected, panel.rows.length - 1)]?.action !== undefined)
    ? ["a"]
    : []
  const merged = Keys.bindings(extensions.keys, summaryAction()).flatMap((binding): Array<Keys.Binding> => {
    if (binding.context === "approval") {
      if (binding.id === "allow-all" && reservedApprovalKeys.includes("a")) return []
      return [{ ...binding, keys: binding.keys.filter((key) => key.startsWith("alt+") === (workerTab !== undefined)) }]
    }
    if (workerTab === undefined || binding.owner !== undefined) return [binding]
    if (binding.id === "cards") return [{ ...binding, label: "Rows" }]
    if (binding.context !== "panel") return [binding]
    // An agent's actions act on its whole run, so its rows have nothing to select.
    if (binding.id === "navigate") return []
    if (binding.id === "close-panel") return [{ ...binding, context: panelFocus ? "panel" : "composer" }]
    if (binding.id === "next-panel-tab") return [{ ...binding, label: "Composer" }]
    const keys = binding.keys.filter((key) => key.startsWith("alt+"))
    return keys.length === 0 ? [] : [{ ...binding, keys, context: panelFocus ? "panel" : "composer" }]
  })
  const dimensions = useTerminalDimensions()
  const activeTabs = snapshot.tabs.filter((tab) => Tabs.live(tab.status))
  const sideChat = focusMain && dimensions.width >= 120
  const chatHeight = focusMain && !sideChat ? Math.floor(dimensions.height * 0.55) : dimensions.height
  const short = chatHeight <= 24
  const showSidebar = dimensions.width >= 100 && activeTabs.length > 0 && (!focusMain || sideChat)
  const width = sideChat ? 40 : Math.max(20, Math.min(columnWidth, dimensions.width - 2 - (showSidebar ? 26 : 0)))
  const mainWidth = Math.max(20, dimensions.width - width - (showSidebar ? 26 : 0) - 2)
  const {
    scroll,
    dragScroll,
    lane,
    rows: chatRows,
    lines,
    cardKeys,
    focusedCard,
    focusedWorker,
    setCardFocus,
    earlierOpen,
    showEarlier,
    openEarlier,
    moveCard,
    reveal,
    monitored,
    showActivity,
    activeInspection,
    inspectionInterrupted,
    jumpTarget,
    workerJump,
    inspectActivity,
    followLive,
    clearInspection,
    workerScroll,
    snapToLive
  } = TranscriptView.useTranscriptView({
    renderer,
    conversation: writer.current.file,
    transcript,
    tabs: snapshot.tabs,
    worker: workspace.transcript,
    filter,
    surface,
    panel,
    setPanelFocus,
    panelFocus,
    width
  })
  const inboxRows = Inbox.flat(inbox, overview.failedOpen === true)
  const inboxKeys = Inbox.keys(inbox, overview.failedOpen === true)
  const overviewShown = surface === "summary" && inboxKeys.length > 0 && !focusMain
  const overviewSelected = overview.selected === SubagentView.chat ||
      inboxKeys.includes(overview.selected ?? "")
    ? overview.selected!
    : inboxKeys[0] ?? SubagentView.chat
  const overviewRow = inboxRows.find((row) => row.key === overviewSelected)
  const overviewTab = overviewRow?.worker
  const overviewBranch = overviewTab === undefined ? [] : Tree.branch(snapshot.tabs, overviewTab.id)
  const overviewCard = overviewBranch.find((tab) => tab.id === overview.card) ?? overviewBranch[0]
  /** A flow or monitor row has no cards, nor does the graph: however it was selected, the keys stay on the list. */
  /** The graph shows for a worker or flow row, never the chat. */
  const overviewGraph = overview.graph === true && overviewRow !== undefined && overviewRow.monitor === undefined &&
    overviewRow.target === undefined
  const overviewPane = overviewRow?.run === undefined && overviewRow?.monitor === undefined &&
      overviewRow?.target === undefined && !overviewGraph
    ? overview.pane
    : "tree"
  // The graph of a flow run draws its node calls, read from the run's events.
  useEffect(() => {
    if (overviewGraph && overviewRow?.run !== undefined) void runs.hydrate(overviewRow.run.id)
  }, [overviewGraph, overviewRow?.run?.id, runs])
  /** The overview takes the keys, except while the conversation review has them. */
  const overviewKeys = overviewShown && panelFocus &&
    !(overviewSelected === SubagentView.chat && overviewPane === "cards")
  const panelScroll = useRef<((direction: number) => void) | undefined>(undefined)
  const lastCtrlC = useRef(0)
  useEffect(() => Log.subscribe((message) => setStatus(message, "danger")), [setStatus])
  /** Each ask that reaches the person says so once, wherever the person is looking. */
  const announcedAsks = useRef(new Set<string>())
  useEffect(() => {
    const open = workspace.asks.list().filter((ask) => ask.holder === Asks.person)
    for (const ask of open) {
      if (announcedAsks.current.has(ask.id)) continue
      announcedAsks.current.add(ask.id)
      const title = workspace.snapshot().tabs.find((tab) => tab.id === ask.from)?.title ?? ask.from
      setStatus(`◆ ${title} asks: ${ask.question}`, "info")
    }
    // Forget the answered ones, so the set stays as small as the open asks.
    const ids = new Set(workspace.asks.list().map((ask) => ask.id))
    for (const id of announcedAsks.current) if (!ids.has(id)) announcedAsks.current.delete(id)
  }, [revision, workspace, setStatus])
  const discoveryFailure = runs.failure()
  const discoveryListed = runs.known() !== undefined
  // Outlives a session switch, so the next session's controller does not bury its acknowledgment.
  const shownDiscovery = useRef<string | undefined>(undefined)
  useEffect(() => {
    const notice = discoveryNotice(shownDiscovery.current, discoveryFailure, discoveryListed)
    shownDiscovery.current = notice.shown
    if (notice.show) setStatus(Failures.sentence("flow", discoveryFailure), "danger")
  }, [discoveryFailure, discoveryListed, setStatus])
  deliver.current = (delivery) => {
    const text = `${delivery.title}: ${
      delivery._tag === "update" ? delivery.text : Failures.sentence("monitor", delivery.failure)
    }`
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
  /** A worker's whole run. */
  const runOf = (tab: Tab) => Undo.run(workspace.transcript(tab.id))
  /** `d`: a settled worker with captured changes. */
  const canDiff = (tab: Tab | undefined): tab is Tab =>
    tab !== undefined && !Tabs.live(tab.status) && Undo.changes(runOf(tab)).length > 0
  /** Built-in actions that apply now, each beside the key that does it in its own view. */
  const paletteActs = Palette.actions({
    diff: panel !== undefined && workerTab === undefined && !overviewShown,
    tabs: snapshot.tabs,
    diffs: snapshot.tabs.filter(canDiff),
    runs: flowRuns,
    monitors: monitors.list(),
    views: uiPanels
  })
  const actsKey = JSON.stringify(paletteActs)
  const keysKey = JSON.stringify(extensions.keys)
  /** Every flow and agent here, with what it takes, its keys and its last run: `/flows` and the home screen. */
  const catalog = useMemo(() =>
    Catalog.entries({
      flows: runs.listed(),
      fields: runs.fields,
      unloaded: runs.unloaded,
      keys: (name) => extensions.keys.filter((each) => each.owner === `repo:${name}`).map((each) => each.key.key),
      runs: runs.snapshot(),
      tabs: snapshot.tabs,
      recorded: runs.history()
    }), [runs, revision, tabsKey, keysKey])
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
          catalog,
          paletteActions,
          paletteActs,
          props.host.credit?.spent
        ),
    [picker, props.models, seat, filter, tabsKey, search?.hits, catalog, actionsKey, actsKey]
  )

  // Key handlers read the latest values through these, never a stale render.
  // `now` is the clock the approval row rendered with, so its keys and its hints agree.
  const live = useRef({
    turn,
    shell,
    undoing,
    followUps,
    seat,
    picker,
    approvals,
    now,
    whichKey,
    steered,
    driven,
    continued,
    workerTab,
    width
  })
  live.current = {
    turn,
    shell,
    undoing,
    followUps,
    seat,
    picker,
    approvals,
    now,
    whichKey,
    steered,
    driven,
    continued,
    workerTab,
    width
  }

  /** Sets the follow-up queue for the screen and for keys handled before the next render. */
  const setQueue = useCallback((next: ReadonlyArray<PromptQueue.Prompt>) => {
    live.current.followUps = next
    setFollowUps(next)
  }, [])
  /** Admits a follow-up for the chat, or for the agent tab `scope` names: recorded in the session file, then shown. */
  const enqueue = useCallback((text: string, scope = "chat") => {
    const next = PromptQueue.enqueue(live.current.followUps, { id: crypto.randomUUID(), text, scope })
    if (next === live.current.followUps) return
    writer.current.append({ type: "queued", at: Date.now(), prompt: next.at(-1)! })
    setQueue(next)
  }, [setQueue])
  /** Takes the scope's oldest follow-up for its turn; the record precedes the turn's own prompt. */
  const dequeue = useCallback((scope = "chat"): string | undefined => {
    const first = PromptQueue.next(live.current.followUps, scope)
    if (first === undefined) return undefined
    writer.current.append({ type: "dequeued", at: Date.now(), id: first.id, reason: "started" })
    setQueue(PromptQueue.remove(live.current.followUps, first.id))
    return first.text
  }, [setQueue])
  // An agent's queued message starts its next turn once it finishes; a stopped agent keeps its queue.
  useEffect(() => {
    for (const tab of workspace.snapshot().tabs) {
      if (tab.status !== "done" && tab.status !== "failed") continue
      const text = dequeue(queueScope(tab))
      if (text === undefined) continue
      try {
        workspace.continue(tab.id, text)
      } catch (error) {
        setStatus(Failures.line("worker", error), "warning")
      }
    }
  }, [revision, followUps, workspace, dequeue, setStatus])

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
        (error) => setStatus(Failures.line("approvals", error), "danger")
      )
    )
    return () => {
      active = false
      stop()
    }
  }, [clockRunning, props.host, setStatus])

  // A build elsewhere leaves a pending target revision; it is read on its own slow poll.
  const readTargets = useCallback(() => {
    const port = props.targets
    if (port === undefined) return
    port.pending().then(
      (listed) =>
        setTargets((current) =>
          current.length === listed.length && current.every((each, index) => each.key === listed[index]!.key)
            ? current
            : listed
        ),
      (error) => setStatus(Failures.line("approvals", error), "danger")
    )
  }, [props.targets, setStatus])
  useEffect(() => {
    readTargets()
    const timer = setInterval(readTargets, 10_000)
    return () => clearInterval(timer)
  }, [readTargets])

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
      }\n${Models.delegateContext(Models.delegable(props.models), props.host.credit?.spent ?? (() => false))}`,
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
      onEvent: (event) => {
        const at = Date.now()
        if (event._tag !== "model-delta") writer.current.append({ type: "event", at, event })

        if (event._tag === "steering-drained") {
          for (const message of event.messages) {
            steered.push(message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""))
          }
        }
        setTranscript((current) => Transcript.apply(current, event, at))
      }
    })
    const state: TurnState = { handle, startedAt, steering }
    live.current.turn = state
    setTurn(state)
    void handle.done.then((outcome) => {
      const at = Date.now()
      const said = [prompt, ...steered].join("\n\n")
      let headline: string | undefined
      if (outcome._tag === "failed") {
        const failure = FailureCopy.describe(outcome.error)
        headline = `${failure.headline}\n${failure.line}`
      }
      writer.current.append({
        type: "outcome",
        at,
        prompt: said,
        outcome: headline === undefined ? outcome : { ...outcome, headline }
      })
      if (outcome._tag === "done") entries.current.push({ kind: "exchange", user: said, answer: outcome.answer })
      if (headline !== undefined) setTranscript((current) => Transcript.failure(current, headline, at))
      if (outcome._tag === "cancelled") setTranscript((current) => Transcript.stopped(current, at))
      live.current.turn = undefined
      setTurn(undefined)
      if (outcome._tag === "cancelled") return
      // Steers no boundary reached, then follow-ups, go next, one turn each.
      const undelivered = steering.take()
      const next = undelivered.length > 0 ? undelivered.join("\n\n") : dequeue()
      if (next !== undefined) startTurnRef.current(next)
    })
  }, [props.host, props.flows, workspace, runs, monitors, contribute, dequeue])
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

  /** Work that an undo's writes could race: a turn, a `!cmd`, another undo, workers and flow runs. */
  const undoBlocked = () => {
    const current = live.current
    return current.turn !== undefined || current.shell !== undefined || current.undoing !== undefined ||
      workspace.busy || runs.busy
  }

  /** Marks the undone files of `plan` in the transcript, the session file and the context. */
  const record = (plan: Undo.Plan, files: ReadonlyArray<Undo.File>, tab: string | undefined) => {
    const at = Date.now()
    const paths = Undo.recorded(plan, files)
    const { calls } = plan
    if (tab !== undefined) workspace.undone(tab, calls, paths, at)
    writer.current.append({ type: "undo", at, calls, paths, ...(tab === undefined ? {} : { tab }) })
    entries.current.push({ kind: "undo", paths })
    if (tab === undefined) setTranscript((current) => Transcript.undone(current, calls, paths, at))
  }

  /** Reads what undoing `cells` would restore and opens the checklist; a run with nothing to write says why. */
  const startUndo = (cells: ReadonlyArray<Undo.Cell>, title: string, tab: string | undefined) => {
    if (undoBlocked()) return setStatus(Undo.message({ _tag: "Busy" }), "warning")
    void Undo.plan(props.host.cwd, cells).then(
      (plan) => {
        if ("_tag" in plan) return setStatus(Undo.message(plan), "warning")
        if (plan.entries.length === 0) {
          // Recorded, so `u` is no longer offered for a run that changed nothing in the end.
          try {
            record(plan, [], tab)
          } catch (error) {
            return setStatus(Failures.line("undo", error), "danger")
          }
          return setStatus(Undo.message({ _tag: "NothingToUndo" }), "warning")
        }
        const checked = Undo.ready(plan)
        if (checked.size === 0) return setStatus(Undo.refusal(plan), "danger")
        // A dialog the person opened meanwhile stays.
        flushSync(() =>
          setPicker((current) =>
            current ??
              { kind: "undo", query: "", selected: 0, title, plan, checked, ...(tab === undefined ? {} : { tab }) }
          )
        )
      },
      (error) => {
        Log.write("undo", error)
        setStatus(Undo.message({ _tag: "WriteFailed", path: "", message: "", restored: true }), "danger")
      }
    )
  }

  /** Writes the checked files in the background; the composer stays usable and the toast settles with the writes. */
  const runUndo = (open: Extract<Picker, { kind: "undo" }>) => {
    if (undoBlocked()) return setStatus(Undo.message({ _tag: "Busy" }), "warning")
    const files = Undo.chosen(open.plan, open.checked)
    if (files.length === 0) return
    const startedAt = Date.now()
    live.current.undoing = startedAt
    setUndoing(startedAt)
    const cwd = props.host.cwd
    void Undo.commit(cwd, files)
      .catch((error): Undo.Failure => {
        Log.write("undo", error)
        return { _tag: "WriteFailed", path: "", message: "", restored: false }
      })
      .then((failure) => {
        if (failure !== undefined) {
          setStatus(
            Undo.message(failure),
            failure._tag === "Conflict" || failure._tag === "WriteFailed" ? "danger" : "warning"
          )
        } else {
          try {
            record(open.plan, files, open.tab)
            setStatus(Undo.done(files))
            // Back to where the run was opened from, which now reads undone.
            setReview(undefined)
          } catch (error) {
            setStatus(`${Undo.done(files)} · ${Failures.line("undo", error)}`, "danger")
          }
        }
        live.current.undoing = undefined
        setUndoing(undefined)
        // A prompt sent while undoing waited, so the model never races the undo's writes.
        const next = live.current.turn === undefined ? dequeue() : undefined
        if (next !== undefined) startTurnRef.current(next)
      })
  }

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
    durableWriter.current = next
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
    setFilesOpen(new Set())
    setOverview({ pane: "tree" })
    clearInspection()
    setNavigation(Panels.initial())
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
    setStatus("New conversation started")
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

  /** `/new` and `/resume` wait for a turn, a `!cmd`, an undo, workers and flow runs, from any door. */
  const occupied = () =>
    live.current.turn !== undefined || live.current.shell !== undefined || live.current.undoing !== undefined ||
    workspace.busy || runs.busy

  /** Places a run a person started in the chat, with the line they typed, and keeps it on the conversation. */
  const showRun = (id: string, title: string, request?: string) => {
    carded.current.add(id)
    const at = Date.now()
    const started = { surface: `flow:${id}`, title, ...(request === undefined ? {} : { request }) }
    writer.current.append({ type: "run", at, ...started })
    setTranscript((current) => Transcript.run(current, started, at))
  }
  /** A person's flow run: acknowledged at once in the chat, settled there from the control plane. */
  const startRun = (flow: string, input: Record<string, unknown>, request?: string) => {
    try {
      const { id } = runs.request({ flow, input, by: "user" })
      userRuns.current.add(id)
      showRun(id, flow, request)
    } catch (error) {
      setStatus(Failures.line("flow", error), "warning")
    }
  }
  /** A custom agent in a worker tab; without a prompt it does what it describes. */
  const startAgent = (agent: string, prompt: string) => {
    const said = prompt !== "" ? prompt : runs.listed().find((each) => each.name === agent)?.description || agent
    try {
      workspace.request({
        id: `${agent}-${Date.now().toString(36)}`,
        title: said.replace(/\s+/g, " ").slice(0, 60),
        prompt: said,
        agent,
        by: "user"
      })
    } catch (error) {
      setStatus(Failures.line("worker", error), "warning")
    }
  }

  const command = useCallback((text: string): boolean => {
    const parsed = Editor.parseCommand(text)
    if (parsed === undefined) return false
    const { name: verb, argument } = parsed
    switch (verb) {
      case "summary":
        showTab("summary")
        return true
      case "smithers":
        if (smithersPanel === undefined) setStatus("No factory for this directory")
        else showTab(`ui:${Smithers.id}`)
        return true
      case "todo": {
        const title = argument.trim()
        if (title === "" || factoryRepo === undefined) {
          setStatus(title === "" ? "Usage: /todo <title>" : "No repository for this directory", "warning")
          return true
        }
        // Acknowledged at once; the filing settles the status when Cloud answers.
        setStatus("TODO requested")
        void (async () => {
          try {
            const cloud = await CloudSession.signedIn(process.env)
            if (cloud === undefined) return setStatus("Sign in to file a TODO: smthrs auth login", "warning")
            todoCloud.current = cloud
            const filed = await todoFiler.current(factoryRepo, title)
            if (filed.ok) {
              setStatus(`TODO ${filed.item.issue === undefined ? "" : `#${filed.item.issue.number} `}queued`)
            } else {
              setStatus(`TODO not filed: ${filed.detail}${filed.settled ? "" : " · /todo again retries it"}`, "warning")
            }
          } catch (error) {
            Log.write("factory.todo", error)
            setStatus(Failures.line("flow", error), "warning")
          }
        })()
        return true
      }
      case "retry": {
        // Factory rows name issues; worker and flow controls stay in Ctrl+K.
        const key = `${factoryRepo}:${Factory.issueOf(argument)}`
        if (factoryRetries.current.has(key)) {
          setStatus(`Retry #${Factory.issueOf(argument)} requested`)
          return true
        }
        const requestedWriter = writer.current
        const record = (line: Factory.Line, required = false) => {
          const at = Date.now()
          const note: Session.Record = { type: "note", at, text: line.text }
          if (required) durableWriter.current.append(note)
          else requestedWriter.append(note)
          setTranscript((current) => Transcript.note(current, line.text, at))
          setStatus(line.text, line.tone)
        }
        const request = Factory.retryCommand(
          argument,
          factoryRepo,
          () => CloudSession.signedIn(process.env),
          (line) => {
            record(line, true)
            factoryRetries.current.add(key)
          },
          (error) => {
            Log.write("factory.retry", error)
            return Failures.line("retry", error)
          }
        )
        if (request.settled === undefined) setStatus(request.now.text, request.now.tone)
        else {
          void request.settled.then((line) => {
            factoryRetries.current.delete(key)
            // A response belongs to the conversation that persisted its request.
            if (writer.current.file === requestedWriter.file) record(line)
            else requestedWriter.append({ type: "note", at: Date.now(), text: line.text })
          })
        }
        return true
      }
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
      case "flows":
        runs.refresh()
        setPicker({ kind: "flows", query: "", selected: 0 })
        return true
      case "flow": {
        const space = argument.search(/\s/)
        const flow = space < 0 ? argument : argument.slice(0, space)
        const rest = space < 0 ? "" : argument.slice(space + 1)
        if (flow === "") {
          runs.refresh()
          setPicker({ kind: "flows", query: "", selected: 0 })
          return true
        }
        const start = () => {
          // An agent's one field is its prompt: the rest of the line, as typed.
          const listed = runs.listed().find((each) => each.name === flow)
          if (listed !== undefined && Extension.isAgent(listed)) return startAgent(flow, rest.trim())
          const parsed = parseArgs(rest)
          if ("error" in parsed) return setStatus(parsed.error, "warning")
          startRun(flow, parsed.input, text.trim())
        }
        // Before the first discovery settles, an agent is not told from a flow yet.
        if (runs.known() !== undefined) start()
        else {
          const settle = () => {
            if (runsRef.current === runs) start()
          }
          void runs.listing().then(settle, settle)
        }
        return true
      }
      case "claude":
      case "codex": {
        // A wrapped harness: the vendor's own agent, with its own tools, as a worker.
        const prompt = argument.trim()
        if (prompt === "") {
          setText(`/${verb} `)
          return true
        }
        try {
          workspace.request({
            id: `${verb}-${Date.now().toString(36)}`,
            title: prompt.replace(/\s+/g, " ").slice(0, 60),
            prompt,
            harness: verb,
            by: "user"
          })
        } catch (error) {
          setStatus(Failures.line("worker", error), "warning")
        }
        return true
      }
      case "model":
        if (argument.includes(":")) switchSeat(argument)
        else setPicker({ kind: "model", query: argument, selected: 0 })
        return true
      case "new":
        if (occupied()) {
          setStatus("Stop running work first", "warning")
        } else newSession()
        return true
      case "resume":
        setPicker({ kind: "resume", query: "", selected: 0, sessions: Session.list(props.host.cwd) })
        return true
      case "conversation": {
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
        const dropped = Context.compactable(entries.current, Math.round(transcript.usage.context / 2))
        if (dropped === 0) {
          setStatus("Nothing to compact")
          return true
        }
        entries.current.splice(0, dropped)
        writer.current.append({ type: "compact", at: Date.now(), dropped })
        setStatus(`Dropped the ${dropped} oldest context entries`)
        return true
      }
      case "name":
        if (argument === "") {
          setStatus(name === undefined ? "This conversation has no name" : `Conversation: ${name}`)
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
      case "devtools": {
        const emit = () =>
          setTranscript((current) =>
            Transcript.note(
              current,
              DevTools.note(argument, {
                activity: current.activity,
                run: runs.get,
                journal: runs.journal,
                width: live.current.width
              }),
              Date.now()
            )
          )
        // A restored tab reads its history first; the note follows the read, whatever it found.
        const tab = DevTools.tabOf(argument)
        if (tab === undefined || runs.get(tab) === undefined) emit()
        else void runs.hydrate(tab).then(emit)
        return true
      }
      case "quit":
      case "exit":
        quit()
        return true
      default:
        setStatus(Editor.unknown(verb), "warning")
        return true
    }
  }, [
    transcript,
    name,
    newSession,
    quit,
    switchSeat,
    setStatus,
    setText,
    props.host.cwd,
    workspace,
    runs,
    revision,
    factoryRepo
  ])

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
    const driving = live.current.driven
    if (driving !== undefined && text === "") {
      // A blank Enter runs the frame waiting for the driver, with nothing new.
      if (!workspace.drive(driving.id, "")) setStatus(`${driving.title} is working`, "info")
      return
    }
    if (text === "") return
    const continuing = live.current.continued
    // A driven worker reads plain text as its next message; `/` and `!` stay commands and shell.
    const target = live.current.workerTab
    const route = Composer.route(text, target !== undefined)
    const verb = route._tag === "command" ? Editor.parseCommand(text)?.name : undefined
    if (
      verb !== undefined && (!Editor.known(verb) ||
        (verb === "retry" && !Editor.parseCommand(text)?.argument.trim().startsWith("#")))
    ) {
      // The typo stays in the composer to fix, without the menu over the suggestion.
      setStatus(verb === "retry" ? "Unknown command /retry" : Editor.unknown(verb), "warning")
      return dismissMenu()
    }
    clearFailure()
    snapToLive()
    const parked = parkedDraft.current
    parkedDraft.current = undefined
    history.current.add(text)
    setText(parked ?? "")
    if (route._tag === "steer" && continuing !== undefined) {
      try {
        workspace.continue(continuing.id, text)
      } catch (error) {
        setText(text)
        setStatus(Failures.line("worker", error), "warning")
      }
      return
    }
    if (route._tag === "steer" && driving !== undefined) {
      if (!workspace.drive(driving.id, text)) setStatus(`${driving.title} is not running`, "warning")
      return
    }
    // A wrapped agent reads no steering, and an unstarted one nothing yet: both get it once they finish.
    if (route._tag === "steer" && (followUp || target!.harness !== undefined || target!.status !== "running")) {
      return enqueue(text, queueScope(target))
    }
    if (route._tag === "steer") {
      if (!workspace.steer(target!.id, text)) {
        setText(text)
        setStatus(workspace.unsteerable(target!.id) ?? `${target!.title} is not running`, "warning")
      }
      return
    }
    if (route._tag === "shell") {
      if (route.command !== "") runShell(route.command, route.excluded)
      return
    }
    if (route._tag === "command" && command(text)) return
    send(text, followUp)
  }, [setText, runShell, command, send, workspace, setStatus, enqueue])

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
        return startRun(action.flow, action.input ?? {})
      case "agent":
        return startAgent(action.agent, action.prompt?.trim() ?? "")
      case "factory-retry":
        command(`/retry #${action.issue}`)
        return
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
  const restoreQueued = useCallback((extra: ReadonlyArray<string> = [], scope = queueScope(live.current.workerTab)) => {
    const scoped = PromptQueue.inScope(live.current.followUps, scope)
    const queued = [...extra.map((text) => ({ text })), ...scoped]
    if (queued.length === 0) return
    const at = Date.now()
    for (const each of scoped) {
      writer.current.append({ type: "dequeued", at, id: each.id, reason: "restored" })
    }
    setQueue(live.current.followUps.filter((each) => each.scope !== scope))
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
      return setFilter((current) => Timeline.toggleKind(current, value.slice(value.indexOf(":") + 1) as Timeline.Kind))
    }
    // A flow added after launch runs only after a restart; its row says so and stays.
    if (open.kind === "flows" && runs.unloaded(value)) return
    setPicker(undefined)
    if (open.kind === "undo") return
    if (open.kind === "stop") {
      const tab = workspace.snapshot().tabs.find((each) => each.id === open.id)
      if (
        value === "stop" && tab !== undefined && workerRun(tab) === open.run &&
        Tabs.actions(tab).some((action) => action.id === "stop") &&
        !confirmedStops.current.has(stopKey(open.id, open.run))
      ) {
        confirmedStops.current.add(stopKey(open.id, open.run))
        workspace.cancel(tab.id)
      }
      return
    }
    if (open.kind === "model") return switchSeat(value)
    if (open.kind === "worker-model") return workspace.retry(open.id, value)
    if (open.kind === "flows") {
      command(`/flow ${value}`)
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
        case "act":
          return actRef.current(chosen.act)
      }
    }
    resumeGuarded(value)
  }, [switchSeat, openSession, setStatus, workspace, runs, setText, command])

  /** Which keys act right now, in the order `handleKey` tries them. */
  const keyContext = (): Keys.KeyContext =>
    Dispatch.context({
      checklist: live.current.picker?.kind === "undo",
      picker: live.current.picker !== undefined,
      review: reviewTab !== undefined,
      inspecting: activeInspection !== undefined,
      form: liveForm.current !== undefined,
      approvals: Approvals.armed(arming.current, live.current.approvals[0]?.requestId, live.current.now),
      empty: composer.current?.plainText === "",
      panel: panelFocus && panel !== undefined,
      overview: overviewKeys,
      completion: liveMenu().menu !== undefined,
      card: focusedCard !== undefined,
      shell: live.current.shell !== undefined || composer.current?.plainText.startsWith("!") === true,
      // An agent tab's composer addresses the agent, never Chat's running turn.
      turn: live.current.turn !== undefined && live.current.workerTab === undefined
    })

  /** `u`: those changes are not all undone, and nothing runs that the writes could race. */
  const canUndo = (tab: Tab | undefined): tab is Tab => canDiff(tab) && !undoBlocked() && Undo.possible(runOf(tab))
  /** The worker's run diff, full height, over the current surface. */
  const openReview = (tab: Tab) => flushSync(() => setReview({ tab: tab.id, surface }))
  const undoWorker = (tab: Tab) => startUndo(runOf(tab), tabTitle(tab), tab.id)
  /** `u` in a worker tab, or on a Summary row: the worker's run, or the chat turn the row belongs to. */
  const undoFrom = (row: Panels.Row | undefined, tab: string | undefined) => {
    const worker = tab === undefined ? undefined : snapshot.tabs.find((each) => each.id === tab)
    if (worker !== undefined) return undoWorker(worker)
    const { prompt, cells } = row === undefined ? { prompt: undefined, cells: [] } : Undo.turn(transcript, row.id)
    return startUndo(
      cells,
      prompt === undefined ? "changes" : Summary.sentence(prompt).replace(/[.!?]+$/, ""),
      undefined
    )
  }

  /** A Ctrl+K action: what its key does in its own view, or the newest change for undo elsewhere. */
  const act = (chosen: Palette.Act) => {
    switch (chosen.act) {
      case "undo": {
        // A worker tab or the Summary review undoes its selected row, as `u` does there.
        if (panel !== undefined && (workerTab !== undefined || (surface === "summary" && !overviewShown))) {
          return undoFrom(panel.rows[Math.min(navigation.selected, panel.rows.length - 1)], workerTab?.id)
        }
        if (reviewTab !== undefined) return undoWorker(reviewTab)
        if (overviewKeys) {
          const selected = overviewPane === "tree" ? overviewTab : overviewCard
          if (selected !== undefined) return undoWorker(selected)
        }
        if (focusedWorker !== undefined) return undoWorker(focusedWorker)
        const latest = Undo.latest(transcript)
        if ("_tag" in latest) return setStatus(Undo.message(latest), "warning")
        return startUndo(
          latest.cells,
          latest.prompt === undefined ? "changes" : Summary.sentence(latest.prompt).replace(/[.!?]+$/, ""),
          undefined
        )
      }
      case "review": {
        const tab = workspace.snapshot().tabs.find((each) => each.id === chosen.id)
        if (canDiff(tab)) openReview(tab)
        return
      }
      case "diff":
      case "split":
        if (panel === undefined) return
        return setNavigation((current) => Panels.navigate(current, chosen.act === "diff" ? "d" : "v", panel.rows))
      case "worker": {
        const tab = workspace.snapshot().tabs.find((each) => each.id === chosen.id)
        if (tab !== undefined) workerAction(tab, chosen.action)
        return
      }
      case "run":
        try {
          if (chosen.action === "stop") runs.cancel(chosen.id)
          else runs.retry(chosen.id)
        } catch (error) {
          setStatus(Failures.line(chosen.action, error), "warning")
        }
        return
      case "monitor":
        try {
          monitors.stop(chosen.id)
        } catch (error) {
          setStatus(Failures.line("monitor", error), "warning")
        }
        return
      case "view":
        return showTab(`ui:${chosen.id}`)
      case "harness": {
        // The composer takes the prompt; the draft comes back on the next submit.
        const draft = composer.current?.plainText ?? ""
        if (draft.trim() !== "") parkedDraft.current = draft
        setPanelFocus(false)
        return setText(`/${chosen.harness} `)
      }
    }
  }
  const actRef = useRef(act)
  actRef.current = act

  const handleKey = (key: KeyEvent): void => {
    const { turn: running, shell: shellRunning, picker: open } = live.current
    const { menu: completing, index: completingIndex } = liveMenu()
    const text = composer.current?.plainText ?? ""
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
    if (
      inspectionInterrupted && open === undefined &&
      (key.name === "escape" || (key.ctrl && key.name === "t" && !showActivity))
    ) {
      key.preventDefault()
      return flushSync(followLive)
    }
    if (key.ctrl && key.name === "t" && showActivity && monitored !== undefined && open === undefined) {
      key.preventDefault()
      flushSync(() => {
        if (activeInspection !== undefined) followLive()
        else inspectActivity(monitored.activity.records.at(-1)!.sequence!, false)
      })
      return
    }
    if (
      activeInspection !== undefined && monitored !== undefined && open === undefined &&
      Dispatch.scrubberKey(key, monitored.activity, activeInspection.seq, {
        follow: () => flushSync(followLive),
        inspect: (seq) => flushSync(() => inspectActivity(seq))
      })
    ) return
    if (
      focusedCard !== undefined && open === undefined && !key.ctrl &&
      (!(key.meta || key.option) || Keys.bindingFor(key, "panel") !== undefined)
    ) {
      if (
        Dispatch.cardKey(key, {
          move: moveCard,
          leave: () => setCardFocus(undefined),
          open: () => {
            if (focusedCard.startsWith("subagents:earlier")) return openEarlier()
            if (focusedWorker !== undefined) return clickTab(`tab:${focusedWorker.id}`)
            const row = chatRows.find((each) => each.key === focusedCard)
            if (row?.item.kind === "run") return perform({ kind: "open", surface: row.item.surface })
            if (row?.item.kind === "card") perform({ kind: "open", surface: `ui:${row.item.panel.id}` })
          },
          worker: focusedWorker,
          workerAction,
          files: () => {
            if (focusedWorker !== undefined) toggleFiles(focusedWorker.id)
          },
          diff: canDiff(focusedWorker) ? () => openReview(focusedWorker) : undefined,
          undo: canUndo(focusedWorker) ? () => undoWorker(focusedWorker) : undefined,
          // The card shows `a Answer` for the one ask waiting.
          answer: focusedWorker !== undefined && soleAsk?.from === focusedWorker.id
            ? () => flushSync(() => openAsk(focusedWorker.id))
            : undefined
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
        setReview(undefined)
        setText("")
      })
      return
    }
    const filling = liveForm.current
    if (filling !== undefined && open === undefined) {
      // Palette, summary and tab switching still work: they close the form and leave the run parked.
      if (!(key.ctrl && ["k", "s", "y", "left", "right", "]", "["].includes(key.name))) {
        return Dispatch.formKey(key, filling, {
          // Retarget the native input before later bytes in the same terminal
          // read arrive. Advancing only the ref leaves typing on the old field.
          change: (next) => flushSync(() => changeForm(next)),
          schema: (id) => id.startsWith(capForm) ? capOffer(id.slice(capForm.length))?.schema : runs.schema(id),
          input: (id) => id.startsWith(capForm) ? {} : runs.get(id)?.input,
          fill: (id, payload) => {
            if (id.startsWith(askForm)) {
              return void workspace.asks.answer(id.slice(askForm.length), String(payload.answer))
            }
            if (!id.startsWith(capForm)) return runs.fill(id, payload)
            const offer = capOffer(id.slice(capForm.length))
            const chosen = offer?.offers[offer.labels.indexOf(String(payload.cap))]
            if (offer === undefined || chosen === undefined) return setStatus("No cap to raise", "warning")
            try {
              workspace.raiseCap(offer.tab.id, { times: chosen })
            } catch (error) {
              setStatus(Failures.line("cap", error), "warning")
            }
          },
          chat: (next) => flushSync(() => setText(next))
        })
      }
      changeForm(undefined)
    }
    if (
      live.current.approvals.length > 0 && text === "" && open === undefined && liveForm.current === undefined &&
      !key.ctrl && !key.meta && !key.option && ["pageup", "pagedown", "home", "end"].includes(key.name)
    ) {
      key.preventDefault()
      const box = approvalScroll.current
      if (box !== null) {
        if (key.name === "home") box.scrollTo(0)
        else if (key.name === "end") box.scrollTop = box.scrollHeight
        else box.scrollBy(key.name === "pageup" ? -1 : 1, "viewport")
      }
      return
    }
    const choice = Approvals.key(key.name, {
      draft: text,
      shift: key.shift,
      ctrl: key.ctrl,
      meta: key.meta || key.option,
      alt: workerTab !== undefined,
      armed: open === undefined && activeInspection === undefined &&
        Approvals.armed(arming.current, live.current.approvals[0]?.requestId, live.current.now),
      pending: live.current.approvals,
      reserved: reservedApprovalKeys
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
      const retry = (failure: unknown) => {
        answered.current.delete(requestId)
        arming.current = Approvals.failed(arming.current, requestId)
        setStatus(Failures.line("approval", failure), "warning")
      }
      props.host.approvals.reply(first!, choice).then(
        (code) => code === undefined ? undefined : retry(Failures.grantRefusal(code)),
        (error) => retry(error)
      )
      return
    }
    if (workerTab !== undefined && open === undefined && activeInspection === undefined && reviewTab === undefined) {
      // A row selection never turns printable input into an agent command.
      if (Dispatch.typing(key) !== undefined) {
        flushSync(() => setPanelFocus(false))
        return
      }
      if (key.name === "escape") {
        key.preventDefault()
        return flushSync(() => {
          if (completing !== undefined && !panelFocus) dismissMenu()
          else showTab("chat")
        })
      }
      if (key.name === "tab" && !key.shift && !key.ctrl && !key.meta && !key.option && completing === undefined) {
        key.preventDefault()
        return flushSync(() => setPanelFocus(!panelFocus))
      }
      if (key.meta || key.option) {
        const binding = Keys.bindingFor(key, "panel")
        if (binding?.id === "approve-form") {
          key.preventDefault()
          return flushSync(() => answerWorker(workerTab.id))
        }
        if (binding?.id === "undo") {
          key.preventDefault()
          return undoFrom(undefined, workerTab.id)
        }
        if (binding?.id === "diff") {
          key.preventDefault()
          if (canDiff(workerTab)) openReview(workerTab)
          return
        }
        const action = binding === undefined ? undefined : Tabs.actionFor(binding.id, workerTab)
        if (action !== undefined) {
          key.preventDefault()
          return workerAction(workerTab, action.id)
        }
      }
      if (key.name === "pageup" || key.name === "pagedown") {
        key.preventDefault()
        return panelScroll.current?.(key.name === "pageup" ? -1 : 1)
      }
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
    if (key.ctrl && key.name === "y") {
      // A worker tab goes back to its parent's tab, or to the chat for a top-level worker.
      // While the person drives it, ctrl+y releases it instead and stays.
      key.preventDefault()
      if (workerTab?.driver !== undefined) {
        workspace.release(workerTab.id)
        return
      }
      if (workerTab !== undefined) {
        flushSync(() => showTab(workerTab.parent === undefined ? "chat" : `tab:${workerTab.parent}`))
      }
      return
    }
    if (key.ctrl && key.name === "s") {
      key.preventDefault()
      const act = summaryAction()
      flushSync(() => {
        if (act.kind === "focus") return setPanelFocus(!panelFocus)
        if (act.kind === "show") return showTab(act.surface)
        showTab("summary")
        if (act.select !== undefined) {
          setOverview({
            selected: act.select,
            pane: "tree",
            failedOpen: inbox.some((section) =>
              section.group === "failed" && section.rows.some((row) => row.key === act.select)
            )
          })
        }
      })
      // After the render, so a pending effect from an earlier tab change cannot clear it.
      if (act.kind === "summary") summaryFrom.current = act.from
      return
    }
    if (focusMain && key.ctrl && key.name === "\\") {
      key.preventDefault()
      flushSync(() => showTab("chat"))
      return
    }
    if (overviewShown && panelFocus && key.name === "tab" && !key.shift && !key.ctrl && open === undefined) {
      // The overview's tab switches between its tree and the selected branch, the review included.
      // A flow row has no cards to act on; the cards pane always shows cards, never a peek.
      key.preventDefault()
      if (
        overviewRow?.run !== undefined || overviewRow?.monitor !== undefined || overviewRow?.target !== undefined ||
        overviewGraph
      ) return
      return setOverview((current) => ({
        ...current,
        selected: overviewSelected,
        pane: current.pane === "tree" ? "cards" : "tree",
        peek: false
      }))
    }
    if (
      (key.ctrl && ["right", "left", "]", "["].includes(key.name)) || (key.name === "tab" && panelFocus && !key.shift)
    ) {
      key.preventDefault()
      flushSync(() => stepTab(surfaces, key.name === "left" || key.name === "["))
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
    if (reviewTab !== undefined && open === undefined && !key.ctrl && !key.meta && !key.option) {
      return Dispatch.reviewKey(key, {
        undo: canUndo(reviewTab) ? () => undoWorker(reviewTab) : undefined,
        close: () => flushSync(() => setReview(undefined)),
        scroll: (by, page) => reviewScroll.current?.(by, page)
      })
    }
    // `a` in the chat answers the one ask waiting, once it has been on screen long enough not to take typing.
    if (
      key.name === "a" && !key.ctrl && !key.meta && !key.option && !key.shift && text === "" && open === undefined &&
      surface === "chat" && !panelFocus && soleAsk !== undefined && live.current.approvals.length === 0 &&
      Date.now() - soleAsk.askedAt >= Approvals.armMs
    ) {
      key.preventDefault()
      return flushSync(() => openAsk(soleAsk.from, "a"))
    }
    if (
      overviewKeys && open === undefined && !key.ctrl &&
      (!(key.meta || key.option) || Keys.bindingFor(key, "panel") !== undefined)
    ) {
      const ids = [SubagentView.chat, ...inboxKeys]
      const overviewWorker = overviewPane === "tree" ? overviewTab : overviewCard
      return Dispatch.overviewKey(key, {
        pane: overviewPane,
        worker: overviewWorker,
        monitor: overviewRow?.monitor?.id
      }, {
        close: () =>
          flushSync(() => {
            setSurface("chat")
            setPanelFocus(false)
            setOverview((current) => ({ ...current, peek: false, graph: false }))
          }),
        release: () => flushSync(() => setPanelFocus(false)),
        stopMonitor: (id) => actRef.current({ act: "monitor", id }),
        pane: () => {
          if (
            overviewRow?.run === undefined && overviewRow?.monitor === undefined && overviewRow?.target === undefined
          ) {
            setOverview((current) => ({ ...current, selected: overviewSelected, pane: "cards", peek: false }))
          }
        },
        tree: (step) => {
          const at = Math.max(0, Math.min(ids.length - 1, ids.indexOf(overviewSelected) + step))
          setOverview((current) => ({ ...current, selected: ids[at]!, card: undefined }))
        },
        peek: () => setOverview((current) => ({ ...current, selected: overviewSelected, peek: current.peek !== true })),
        graph: () =>
          setOverview((current) => ({
            ...current,
            selected: overviewSelected,
            pane: "tree",
            graph: current.graph !== true
          })),
        answer: () =>
          flushSync(() => {
            if (overviewRow?.worker !== undefined) answerWorker(overviewRow.worker.id)
            else if (overviewRow?.run?.status === "input") openForm(overviewRow.run.id)
          }),
        card: (direction) => {
          if (overviewCard === undefined) return
          // Two lanes are two grids at half width: arrows move within the one on screen, in its order.
          const split = overviewTab === undefined ? undefined : Subagents.lanes(snapshot.tabs, overviewTab.id)
          const lanes = split === undefined
            ? [overviewBranch]
            : [split.implement, split.poc]
          const order = lanes.flat()
          const keys = order.map((tab) => Subagents.cardKey(tab.id))
          const grid = SubagentView.overviewWidths(width).grid
          const next = Subagents.move(
            keys,
            lanes.map((lane) => lane.map((tab) => Subagents.cardKey(tab.id))),
            split === undefined ? grid : SubagentView.laneWidth(grid) - 2,
            Subagents.cardKey(overviewCard.id),
            direction
          )
          setOverview((current) => ({ ...current, card: order[keys.indexOf(next)]?.id }))
        },
        open: () => {
          if (overviewSelected === Inbox.failedKey) {
            return setOverview((current) => ({ ...current, failedOpen: current.failedOpen !== true }))
          }
          setOverview((current) => ({ ...current, peek: false, graph: false }))
          if (overviewPane === "tree" && overviewRow?.run !== undefined) return clickTab(`flow:${overviewRow.run.id}`)
          if (overviewRow?.monitor !== undefined || overviewRow?.target !== undefined) return
          if (overviewPane === "tree" && overviewTab === undefined) {
            return setOverview((current) => ({ ...current, selected: overviewSelected, pane: "cards" }))
          }
          const target = overviewPane === "tree" ? overviewTab : overviewCard
          if (target !== undefined) clickTab(`tab:${target.id}`)
        },
        files: () => {
          if (overviewCard !== undefined) toggleFiles(overviewCard.id)
        },
        scroll: (direction) => panelScroll.current?.(direction),
        workerAction,
        diff: canDiff(overviewWorker) ? () => openReview(overviewWorker) : undefined,
        undo: canUndo(overviewWorker) ? () => undoWorker(overviewWorker) : undefined,
        decideTarget: overviewRow?.target === undefined || props.targets === undefined
          ? undefined
          : (decision) => {
            const target = overviewRow.target!
            props.targets!.decide(target, decision).then(
              () => {
                setTargets((current) => current.filter((each) => each.key !== target.key))
                readTargets()
              },
              (error) => setStatus(Failures.line("approval", error), "warning")
            )
          }
      })
    }
    if (
      panelFocus && panel !== undefined && open === undefined && !key.ctrl &&
      (!(key.meta || key.option) || Keys.bindingFor(key, "panel") !== undefined)
    ) {
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
            setStatus(Failures.line("retry", error), "warning")
          }
        },
        continueRun: (id) => {
          try {
            runs.retry(id)
          } catch (error) {
            setStatus(Failures.line("continue", error), "warning")
          }
        },
        cancelRun: runs.cancel,
        fillRun: (id) => flushSync(() => openForm(id)),
        undo: (row) => undoFrom(row, undefined),
        scroll: (direction) => panelScroll.current?.(direction),
        navigate: setNavigation,
        send: (prompt) => send(prompt),
        perform
      })
    }
    if (open?.kind === "undo") {
      return Dispatch.checklistKey(key, { rows: open.plan.entries.length }, {
        close: () => flushSync(() => setPicker(undefined)),
        select: (update) =>
          flushSync(() =>
            setPicker((current) => current === undefined ? current : { ...current, selected: update(current.selected) })
          ),
        toggle: () =>
          flushSync(() =>
            setPicker((current) =>
              current?.kind !== "undo" ? current : {
                ...current,
                checked: Undo.toggle(current.plan, current.checked, current.plan.entries[current.selected]!.path)
              }
            )
          ),
        undo: () => {
          if (Undo.chosen(open.plan, open.checked).length === 0) return
          flushSync(() => setPicker(undefined))
          runUndo(open)
        }
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
              current === undefined || current.kind === "undo" || current.kind === "stop"
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
          restoreQueued(running.steering.take(), "chat")
          running.handle.cancel()
        }
      },
      shell: shellRunning,
      history: history.current,
      scroll: scroll.current
    }, {
      stopSteering: () => flushSync(() => showTab("chat")),
      setText: (next) => setText(next),
      quit,
      submit: (followUp) => submit(followUp),
      restoreQueued: () => restoreQueued(),
      pickModel: () => flushSync(() => setPicker({ kind: "model", query: "", selected: 0 })),
      cycleModel,
      toggleExpanded: () => setExpanded((value) => !value),
      externalEditor: () => void externalEditor(renderer, setStatus)
    })
  }

  useKeyboard(handleKey)
  usePaste(() => {
    if (
      workerTab !== undefined && panelFocus && live.current.picker === undefined && liveForm.current === undefined &&
      activeInspection === undefined && !whichKeyRef.current
    ) {
      // Global paste handlers run before native delivery. Commit focus now so
      // this paste and later bytes in the same terminal read reach the composer.
      flushSync(() => setPanelFocus(false))
    }
  })

  const working = turn !== undefined
  const bashMode = draft.startsWith("!")
  const window = props.contextWindow(seat)
  const accent = driven !== undefined
    ? color.needs
    : bashMode
    ? color.success
    : steered !== undefined
    ? lane(steered.id)
    : working
    ? color.faint
    : color.brand
  const tabsWidth = width - (focusMain ? 6 : 0)
  const footerContext = keyContext()
  // The front row's keys, as the row and the footer both offer them.
  const offered = approvals[0] === undefined ? [] : Approvals.choices(approvals[0], !reservedApprovalKeys.includes("a"))
  const approvalReady = approvals[0] !== undefined && picker === undefined && form === undefined &&
    activeInspection === undefined && Approvals.ready(arming.current, approvals[0].requestId, now, draft)
  /** A worker action's registry binding, as a footer hint. */
  const actionHints = (tab: Tab) =>
    Tabs.actions(tab).flatMap((action) =>
      Keys.registry.filter((binding) => binding.id === action.binding).map((binding) => ({
        ...binding,
        label: action.label
      }))
    )
  const cardHint = (id: string) => Keys.registry.filter((binding) => binding.id === id)
  /** The undo checklist's keys, in its dialog and the footer: Enter names what it writes, and only while a file is checked. */
  const checklistKeys = picker?.kind === "undo"
    ? [
      ...cardHint("undo-files").flatMap((binding) => {
        const files = Undo.chosen(picker.plan, picker.checked)
        return files.length === 0 ? [] : [{ ...binding, label: Undo.label(files) }]
      }),
      ...cardHint("undo-back")
    ]
    : undefined
  // A worker's own actions are buttons in its view; the footer carries the rest.
  const footerHints = footerContext === "approval"
    ? approvalReady
      ? offered.flatMap((offer) =>
        merged.filter((binding) => binding.id === offer.id).map((binding) => ({ ...binding, label: offer.label }))
      )
      : []
    : footerContext === "completion"
    ? Keys.hintsFor(footerContext, merged)
    : driven !== undefined && !panelFocus && picker === undefined && form === undefined &&
        activeInspection === undefined
    ? [
      ...cardHint("send"),
      ...cardHint("parent").map((binding) => ({ ...binding, label: "Release" }))
    ]
    : workerTab !== undefined && !panelFocus && picker === undefined && form === undefined &&
        activeInspection === undefined && reviewTab === undefined
    ? [
      // Enter steers a running agent, continues a finished one, and otherwise queues for when it finishes.
      ...steered !== undefined
        ? [...cardHint("steer"), ...cardHint("queue")]
        : continued !== undefined
        ? cardHint("send")
        : cardHint("send").map((binding) => ({ ...binding, label: "Queue" })),
      ...cardHint("close-panel"),
      ...cardHint("keys")
    ]
    : footerContext === "checklist" && checklistKeys !== undefined
    ? checklistKeys
    : footerContext === "review" && reviewTab !== undefined
    ? [...(canUndo(reviewTab) ? cardHint("review-undo") : []), ...cardHint("review-close")]
    : footerContext === "card" && focusedWorker !== undefined
    ? [
      ...(canDiff(focusedWorker) ? cardHint("card-diff") : []),
      ...(canUndo(focusedWorker) ? cardHint("card-undo") : []),
      ...cardHint("open-card"),
      ...cardHint("card-move"),
      ...actionHints(focusedWorker),
      ...((Subagents.subagent(focusedWorker, workspace.transcript(focusedWorker.id), props.models).files?.length ?? 0) >
          0
        ? cardHint("card-files")
        : [])
    ]
    : footerContext === "panel" && workerTab !== undefined
    ? [
      ...(canDiff(workerTab) ? ["diff"] : []),
      ...(canUndo(workerTab) ? ["undo"] : []),
      "next-panel-tab",
      "close-panel",
      "keys"
    ].flatMap((id) => merged.filter((binding) => binding.id === id))
    : footerContext === "panel" && panel !== undefined
    ? [
      ...(surface === "summary" ? Keys.panelHints({}).filter((binding) => binding.id === "close-panel") : []),
      ...Keys.panelHints({
        ...selectedFlowActions,
        // The chat turn of the selected row, when it has changes to undo.
        undo: surface === "summary" && !undoBlocked() &&
          Undo.possible(
            Undo.turn(
              transcript,
              panel.rows[Math.max(0, Math.min(navigation.selected, panel.rows.length - 1))]?.id ?? ""
            )
              .cells
          ),
        action: panel.rows[Math.max(0, Math.min(navigation.selected, panel.rows.length - 1))]?.action?.label
      }).filter((binding) => surface !== "summary" || binding.id !== "close-panel"),
      // A contributed panel key works only on its owner's view; a global one works here too.
      ...Keys.hintsFor("panel", merged).filter((binding) =>
        binding.owner !== undefined && (binding.context !== "panel" || binding.owner === ownerOf(surface))
      )
    ]
    : footerContext === "form" && form?.ask !== undefined
    ? [
      ...cardHint("run-form").map((binding) => ({ ...binding, label: "Answer" })),
      ...cardHint("close-form").map((binding) => ({ ...binding, label: "Back" }))
    ]
    : footerContext === "form" && form !== undefined
    ? Keys.formHints(form.fields[form.focus]?.kind)
    : footerContext === "picker" && picker?.kind === "flows"
    ? Keys.catalogHints(rows.length > 0 && !runs.unloaded(rows[Math.min(picker.selected, rows.length - 1)]!.value))
    : footerContext === "overview"
    // `d` and `u` act on a settled worker; a monitor has no cards, graph or view to open.
    ? [
      ...(overviewRow?.monitor === undefined ? [] : cardHint("stop")),
      ...(overviewRow?.target === undefined ? [] : [...cardHint("overview-approve"), ...cardHint("overview-deny")]),
      ...(canDiff(overviewPane === "tree" ? overviewTab : overviewCard) ? cardHint("overview-diff") : []),
      ...(canUndo(overviewPane === "tree" ? overviewTab : overviewCard) ? cardHint("overview-undo") : []),
      ...Keys.hintsFor("overview", merged).filter((binding) =>
        (binding.id !== "overview-answer" || overviewRow?.ask !== undefined || overviewRow?.run?.status === "input" ||
          (overviewRow?.worker !== undefined && overviewRow.worker.status === "failed" &&
            Budget.capped(overviewRow.worker.failure) && props.host.runCap !== undefined)) &&
        ((overviewRow?.monitor === undefined && overviewRow?.target === undefined) ||
          !["overview-graph", "overview-open", "overview-pane"].includes(binding.id))
      )
    ]
    // `a Answer` follows Summary while the chat's `a` answers the one ask waiting.
    : Keys.hintsFor(footerContext, merged).flatMap((binding) =>
      binding.id === "summary" && footerContext === "composer" && soleAsk !== undefined && surface === "chat" &&
        draft === ""
        ? [binding, ...cardHint("answer")]
        : [binding]
    )
  const meter = AppView.meter(transcript, window)
  /** A run card's run; while its form is open below, the form asks, so the card does not repeat it. */
  const runCard = (surface: string): FlowRun | undefined => {
    const run = surface.startsWith("flow:") ? runs.get(surface.slice(5)) : undefined
    return run !== undefined && form?.id === run.id ? { ...run, message: undefined } : run
  }
  const toastRows = Toasts.rows({
    tabs: snapshot.tabs,
    runs: flowRuns,
    search,
    undoing,
    toast,
    now,
    tick,
    ...(surface === "chat" && panel === undefined
      ? {
        carded: new Set(
          transcript.items.flatMap((item) =>
            item.kind === "run" && item.surface.startsWith("flow:") ? [item.surface.slice(5)] : []
          )
        )
      }
      : {})
  })
  /** What every subagent card in the chat reads and does. */
  const cards: SubagentView.Cards = {
    transcript: workspace.transcript,
    models: props.models,
    now,
    lane,
    focused: focusedCard,
    open: filesOpen,
    onOpen: (id) => clickTab(`tab:${id}`),
    onFiles: toggleFiles,
    onAction: workerAction,
    ask: (id) => workspace.asks.fromPerson(id),
    ...(form !== undefined ? { answering: true } : soleAsk === undefined ? {} : { answers: soleAsk.from })
  }
  const toastWidth = Math.min(60, mainWidth - 2)
  const toastHeight = Math.min(Math.floor(dimensions.height / 2), Math.max(1, toastRows.length * 3))
  const toastLimit = Math.max(1, Math.floor(chatHeight / 4))
  const completionRows = short || approvals.length > 0 ? Math.max(1, Math.floor(chatHeight / 4)) : 8
  const completionHeight = menu === undefined || panelFocus || form !== undefined || reviewTab !== undefined
    ? 0
    : 1 + Math.min(completionRows, Math.max(1, menu.items.length))
  // Reserve both controls together, including their margins, the largest composer,
  // model/footer, tabs/status, and queued prompts/toasts.
  const approvalHeight = Math.max(
    2,
    Math.min(
      Math.floor(chatHeight / 2),
      chatHeight - completionHeight - (short ? Math.floor(chatHeight / 4) : Math.floor(chatHeight / 3)) - 7 -
        Math.min(toastLimit, View.toastStackRows(toastRows, mainWidth, short)) -
        (shownQueue.length === 0 ? 0 : (short ? 3 : shownQueue.length + 2))
    )
  )
  const formHeight = Math.max(
    3,
    chatHeight - (short ? 2 : 4) -
      Math.min(toastLimit, View.toastStackRows(toastRows, mainWidth, short)) -
      (shownQueue.length === 0 ? 0 : (short ? 3 : shownQueue.length + 2))
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
                ask={(id) => workspace.asks.fromPerson(id)}
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
            paddingTop: 0
          }}
        >
          <box style={{ flexDirection: "row", flexShrink: 0, marginBottom: 0, width }}>
            {focusMain ? <text fg={color.brand} style={{ flexShrink: 0 }}>Chat{"  "}</text> : null}
            {(() => {
              const note = Timeline.active(filter) && surface === "chat"
                ? filter.query === "" ? " filtered" : ` grep ${filter.query}`
                : ""
              return (
                <>
                  <TabStrip
                    chips={surfaces}
                    active={surface}
                    width={tabsWidth - note.length}
                    onSelect={clickTab}
                    counts={{
                      working: snapshot.tabs.filter((tab) => Tabs.live(tab.status)).length +
                        flowRuns.filter((run) =>
                          !settled(run.status)
                        ).length,
                      failed: snapshot.tabs.filter((tab) =>
                        tab.status === "failed"
                      ).length +
                        flowRuns.filter((run) => run.status === "failed").length
                    }}
                  />
                  {note === ""
                    ? null
                    : <text fg={color.warning} wrapMode="none" style={{ flexShrink: 0 }}>{note}</text>}
                </>
              )
            })()}
          </box>
          <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: "hidden" }}>
            {reviewTab !== undefined ?
              (
                <ReviewView
                  title={tabTitle(reviewTab)}
                  changes={Undo.changes(Undo.run(workspace.transcript(reviewTab.id)))}
                  scrollRef={reviewScroll}
                />
              ) :
              workerTab !== undefined && !focusMain ?
              (
                <WorkerView
                  tab={{ ...workerTab, title: tabTitle(workerTab) }}
                  transcript={workspace.transcript(workerTab.id)}
                  models={props.models}
                  now={now}
                  tick={tick}
                  tone={lane(workerTab.id)}
                  width={width}
                  expanded={expanded}
                  height={chatHeight - 4}
                  onAction={(action) => workerAction(workerTab, action)}
                  jump={workerJump(workerTab.id)}
                  scrollRef={panelScroll}
                  viewportRef={workerScroll}
                  onBack={() => clickTab(workerTab.parent === undefined ? "chat" : `tab:${workerTab.parent}`)}
                  onRelease={() => workspace.release(workerTab.id)}
                  tabs={snapshot.tabs}
                  cards={{
                    ...cards,
                    focused: focusedCard === Subagents.earlierKey(workerTab.id) ? focusedCard : undefined
                  }}
                  earlierOpen={earlierOpen(workerTab.id)}
                  onEarlier={() => showEarlier(workerTab.id)}
                />
              ) :
              overviewShown && panel !== undefined ?
              (
                <SubagentView.Overview
                  sections={inbox}
                  tabs={snapshot.tabs}
                  asks={workspace.asks.list()}
                  {...(overviewGraph
                    ? {
                      graph: SubagentView.forest(overviewRow, Inbox.flat(inbox, true), snapshot.tabs, runs.nodes, now)
                    }
                    : {})}
                  {...(overview.peek === true && overviewRow !== undefined
                    ? { peek: Inbox.peek(overviewRow, workspace.transcript) }
                    : {})}
                  selected={overviewSelected}
                  failedOpen={overview.failedOpen === true}
                  pane={overviewPane}
                  width={width}
                  cards={{
                    ...cards,
                    focused: overviewPane === "cards" && overviewCard !== undefined
                      ? Subagents.cardKey(overviewCard.id)
                      : undefined
                  }}
                  onSelect={(id) => setOverview((current) => ({ ...current, selected: id, card: undefined }))}
                  review={
                    <PanelView
                      panel={panel}
                      navigation={navigation}
                      height={dimensions.height - 12}
                      width={SubagentView.overviewWidths(width).grid}
                      scrollRef={panelScroll}
                    />
                  }
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
              lines.length === 0 && !Timeline.active(filter)
              ? form === undefined
                ? (
                  <View.Home
                    width={width}
                    flows={catalog.filter((entry) => !entry.unloaded)}
                    rows={chatHeight - 15}
                    onRun={(name) => command(`/flow ${name}`)}
                  />
                )
                : <box style={{ flexGrow: 1, minHeight: 0 }} />
              : (
                <scrollbox
                  ref={scroll}
                  stickyScroll
                  stickyStart="bottom"
                  style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, scrollbarOptions: { visible: false } }}
                >
                  <SubagentView.Lines
                    lines={lines}
                    onEarlier={() => showEarlier()}
                    width={width}
                    cards={cards}
                    row={({ row }) => {
                      const card = row.item.kind === "card" ? livePanel(row.item.panel) : undefined
                      const started = row.item.kind === "run" ? row.item : undefined
                      const step = row.item.kind === "cell" ? Scrubber.step(transcript, row.item) : undefined
                      return (
                        <box key={row.key} id={row.key}>
                          {started !== undefined
                            ? (
                              <View.RunCard
                                title={started.title}
                                request={started.request}
                                run={runCard(started.surface)}
                                now={now}
                                focused={row.key === focusedCard}
                                onOpen={() => perform({ kind: "open", surface: started.surface })}
                              />
                            )
                            : card !== undefined
                            ? (
                              <View.Card
                                panel={card}
                                status={cardStatus(card)}
                                focused={row.key === focusedCard}
                                onOpen={() => perform({ kind: "open", surface: `ui:${card.id}` })}
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
                              />
                            )}
                        </box>
                      )
                    }}
                  />
                  {working && transcript.thinking
                    ? <text fg={color.muted} style={{ paddingLeft: 2 }}>{tick} thinking</text>
                    : null}
                </scrollbox>
              )}
            {expanded && reviewTab === undefined
              ? (
                <text fg={color.faint} wrapMode="none" style={{ height: 1, flexShrink: 0, paddingLeft: 2 }}>
                  {AppView.usageDetails(AppView.sessionUsage(transcript, snapshot.tabs, workspace.transcript))}
                </text>
              )
              : null}
            {activeInspection === undefined || monitored === undefined || reviewTab !== undefined ?
              null :
              (
                <box style={{ position: "absolute", top: 0, left: 0, height: 1, width }}>
                  <ActivityView
                    activity={monitored.activity}
                    width={width}
                    now={now}
                    title={monitored.title}
                    focused
                    cursor={activeInspection.seq}
                    onSelect={inspectActivity}
                    onPause={followLive}
                  />
                </box>
              )}
          </box>
          {shownQueue.length === 0 || reviewTab !== undefined ?
            null :
            (
              <box style={{ marginTop: 1, paddingLeft: 2, flexShrink: 0 }}>
                {(short ? shownQueue.slice(-1) : shownQueue).map((prompt) => (
                  <text key={prompt.id} fg={color.muted} wrapMode="none">
                    {short ? `${shownQueue.length} queued: ` : "Follow-up: "}
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
              width={width}
              height={formHeight}
              compact={short}
              onField={(field, text) => {
                const current = liveForm.current
                if (current !== undefined) {
                  changeForm({
                    ...current,
                    draft: { ...current.draft, [field]: text },
                    ...(current.ask === undefined ? {} : {
                      ask: { ...current.ask, choice: current.ask.options.length, moved: true }
                    }),
                    error: undefined
                  })
                }
              }}
            />
          )}
          {menu === undefined || panelFocus || form !== undefined || reviewTab !== undefined ?
            null :
            (
              <CompletionMenu
                menu={menu}
                selected={menuIndex}
                seat={seat}
                rows={completionRows}
              />
            )}
          {sideChat ?
            null :
            <View.ToastStack rows={toastRows} height={toastLimit} compact={short} onAction={workerAction} />}
          {approvals[0] === undefined ? null : (
            <View.Approval
              width={width}
              maxHeight={approvalHeight}
              key={approvals[0].requestId}
              scrollRef={approvalScroll}
              request={approvals[0]}
              choices={offered}
              alt={workerTab !== undefined}
              armed={approvalReady}
              more={approvals.length - 1}
              lines={short ? 2 : Math.max(2, Math.min(8, Math.floor(dimensions.height / 6)))}
              {...(approvals[0].source === "chat"
                ? {}
                : {
                  worker: snapshot.tabs.find((tab) => tab.id === approvals[0]!.source)?.title ??
                    flowRuns.find((run) => `flow:${run.id}` === approvals[0]!.source)?.flow ?? approvals[0].source
                })}
            />
          )}
          <box
            // Kept mounted under a form or a full-height diff, so a draft survives it.
            visible={form === undefined && reviewTab === undefined}
            style={{ border: ["left"], flexShrink: 0 }}
            borderColor={accent}
            customBorderChars={View.bar}
          >
            <box
              style={{ paddingLeft: 2, paddingRight: 2 }}
              backgroundColor={color.surface}
            >
              <textarea
                ref={composer}
                selectionOccupancy="boundary"
                focused={picker === undefined && !panelFocus && form === undefined && reviewTab === undefined}
                placeholder={workerTab !== undefined && driven === undefined
                  ? `Continue ${tabTitle(workerTab)}`
                  : driven !== undefined
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
                    : Math.max(1, Math.floor(chatHeight / 3))
                }}
              />
              <text wrapMode="none" style={{ height: 1, flexShrink: 0 }}>
                {driven !== undefined
                  ? (
                    <>
                      <span fg={color.needs}>{`⇄ driving ${driven.title}`}</span>
                      <span fg={color.faint}>{"  ·  "}</span>
                    </>
                  )
                  : bashMode || steered !== undefined
                  ? (
                    <>
                      <span fg={accent}>{bashMode ? "shell" : `steer ↳ ${steered!.title}`}</span>
                      <span fg={color.faint}>{"  ·  "}</span>
                    </>
                  )
                  : null}
                <AppView.ComposerModel seat={seat} models={props.models} worker={driven ?? steered} />
              </text>
            </box>
          </box>
          <StatusLine
            lead={`${basename(props.host.cwd)}${props.branch === undefined ? "" : ` (${props.branch})`}`}
            width={width}
            hints={footerHints}
            items={statusItems}
            onItem={(item) => item.action === undefined ? undefined : perform(item.action)}
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
            <View.ToastStack rows={toastRows} height={toastLimit} compact={short} onAction={workerAction} />
          </box>
        )
        : null}
      {picker === undefined ? null : (
        <PickerDialog
          title={Pickers.title(picker, parsedPalette?.mode === "text" && search?.truncated === true)}
          query={picker.kind === "undo" || picker.kind === "stop" ? undefined : picker.query}
          onQuery={(query) =>
            flushSync(() =>
              setPicker((
                current
              ) => (current === undefined || current.kind === "undo" || current.kind === "stop"
                ? current
                : { ...current, query, selected: 0 })
              )
            )}
          rows={rows}
          selected={picker.selected}
          empty={Pickers.empty(
            picker,
            () => {
              const discovery = runs.failure()
              return discovery !== undefined
                ? Failures.sentence("flow", discovery)
                : runs.opening
                ? "Opening flows"
                : "No flows"
            },
            search?.status === "running"
          )}
          width={Math.min(72, dimensions.width - 4)}
          height={dimensions.height}
          {...(checklistKeys === undefined ? {} : { keys: checklistKeys })}
        />
      )}
    </box>
  )
}
