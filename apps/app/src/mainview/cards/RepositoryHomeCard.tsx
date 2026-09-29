import { Button, ChatComposer, Markdown } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useCallback, useContext, useSyncExternalStore } from "react"
import type { Card } from "../state/AppState"
import { ControllerContext, useController } from "../ControllerContext"
import { dynamicFlowAction, flowProps } from "../flows/FlowAction"
import { repositoryFlowName } from "../flows/entries/flow"
import type { CardFamily, RunDynamicCommand } from "./CardFamily"
import { RUN_PHASE_WORDS } from "./RunTraceSummary"
import { HomeStack, useStackSnapshot } from "./StackCard"
import { wikiRow, wikiTone } from "@smthrs/rpc/StackView"
import "./RepositoryHomeCard.css"

/*
 * The app home (PRODUCT.md D-18): the repository's declared homepage, rendered
 * from its typed blocks. A `prompt` block is the heading and the composer; the
 * `app` blocks are the grid of apps — an app is a featured flow with a
 * picture, and nothing more. Opening a tile invokes its flow with no input,
 * so THE FORM LAW renders that flow's form (one input, one button) and the
 * real run card follows. A tile with a last result shows that result in its
 * picture; otherwise it shows the static picture of what the app makes.
 */

type HomeCard = Extract<Card, { kind: "factory.home" }>
type HomeBlock = Extract<HomeCard["payload"]["home"], { kind: "blocks" }>["blocks"][number]
export type HomeApp = Extract<HomeBlock, { type: "app" }>
type RunCard = Extract<Card, { kind: "run-trace" }>

/** The home's apps, in declaration order; the grid renders them together where the first one sits. */
export const homeApps = (home: HomeCard["payload"]["home"] | undefined): ReadonlyArray<HomeApp> =>
  home?.kind === "blocks" ? home.blocks.filter((block): block is HomeApp => block.type === "app") : []

/*
 * The shared markdown renderer builds React nodes and filters unsafe link
 * schemes; raw HTML outside code fences is dropped so it never shows as text.
 * Fenced code keeps its angle brackets (`Array<string>`, JSX examples).
 */
const stripHtml = (value: string): string => value
  .replace(/<!--[^]*?-->/g, "")
  .replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, "")
  .replace(/<\/?[A-Za-z][^>]*>/g, "")

export const stripHomeHtml = (value: string): string =>
  value.split(/(^ {0,3}```[^]*?^ {0,3}```[^\n]*$)/m).map((part, index) => index % 2 === 1 ? part : stripHtml(part)).join("")

const HomePrompt = ({ flow, placeholder, onRunCommand }: {
  readonly flow?: string; readonly placeholder?: string; readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const controller = useController()
  const { data: rows } = useLiveQuery((q) => q.from({ session: controller.store.collections.sessions })
    .select(({ session }) => ({ id: session.id, draft: session.draft })))
  const draft = rows[0]?.draft ?? controller.store.session().draft
  return <ChatComposer
    className="smithers-composer factory-home-composer"
    value={draft}
    onValueChange={controller.changeDraft}
    placeholder={placeholder}
    inputAriaLabel={placeholder ?? "Message"}
    lifecycleStatus={controller.store.session().phase === "responding" ? "submitted" : "ready"}
    /* The chord that summons the same composer anywhere (App.tsx). */
    actions={<kbd className="factory-home-kbd" aria-hidden="true">⌘K</kbd>}
    submitProps={flowProps("chat.send")}
    onSubmit={() => {
      const text = controller.store.session().draft.trim()
      if (!text) return
      const line = flow ? `/${repositoryFlowName(flow)} ${text}` : text
      if (flow) controller.changeDraft(line)
      onRunCommand("chat.send", line)
    }} />
}

/* The static pictures: what each app makes, drawn, never said (aria-hidden). They claim no state: status comes only from a run or the Wiki. */
const Picture = ({ kind }: { readonly kind: HomeApp["picture"] }) => {
  switch (kind) {
    case "issue":
      return <>
        <span className="app-picture-card">
          <span className="app-picture-row"><span className="app-chip" data-tone="danger">#42</span><span className="app-line" /></span>
          <span className="app-picture-flow"><span>Plan</span><span>Fix</span><span>Check</span><span>PR</span></span>
        </span>
      </>
    case "review":
      return <>
        <span className="app-picture-card app-picture-diff">
          <code data-diff="del">- const t = 30</code>
          <code data-diff="add">+ const t = timeout()</code>
          <code data-diff="add">+ test("timeout")</code>
        </span>
      </>
    case "wiki":
      return <span className="app-picture-card app-picture-page">
        <span className="app-line" data-ink="true" />
        <span className="app-line" />
        <span className="app-line" />
        <span className="app-line" />
      </span>
    case "schedule":
      return <>
        <span className="app-clock"><span className="app-clock-hour" /><span className="app-clock-minute" /></span>
        <span className="app-days">
          <span className="app-chip">Mon</span>
          <span className="app-chip">Tue</span>
          <span className="app-chip">Wed</span>
        </span>
      </>
  }
}

const NO_CARDS = { subscribe: () => () => {}, get: () => undefined }

/** The newest run card of one workflow on one repository: the app's last result. */
export const lastRunOf = (cards: Iterable<Card>, repo: string, workflow: string): RunCard | undefined => {
  let latest: RunCard | undefined
  for (const card of cards) {
    if (card.kind !== "run-trace" || card.payload.repo !== repo || card.payload.workflow !== workflow) continue
    if (latest === undefined || card.createdAt > latest.createdAt || (card.createdAt === latest.createdAt && card.ordinal > latest.ordinal)) latest = card
  }
  return latest
}

/** The live last result of an app: the newest run card of the workflow its flow launches; absent outside a controller. */
const useLastRun = (repo: string, workflow: string | undefined): RunCard | undefined => {
  const cards = useContext(ControllerContext)?.store.collections.cards
  const subscribe = useCallback((notify: () => void) => {
    if (cards === undefined || workflow === undefined) return NO_CARDS.subscribe()
    const subscription = cards.subscribeChanges(notify)
    return () => subscription.unsubscribe()
  }, [cards, workflow])
  const read = useCallback(() => cards === undefined || workflow === undefined ? undefined : lastRunOf(cards.values(), repo, workflow), [cards, repo, workflow])
  return useSyncExternalStore(subscribe, read, read)
}

/** A run's phase as a chip tone. */
const phaseTone = (phase: RunCard["payload"]["phase"]): "success" | "danger" | "brand" | "info" =>
  phase === "completed" ? "success" : phase === "failed" || phase === "no-capacity" ? "danger" : phase === "cancelled" || phase === "stopped" ? "info" : "brand"

/** The live preview: the last result where one exists, otherwise the picture. */
const AppTilePicture = ({ app, repo, workflow }: { readonly app: HomeApp; readonly repo: string; readonly workflow: string | undefined }) => {
  const run = useLastRun(repo, workflow)
  const snapshot = useStackSnapshot(repo)
  const wiki = app.picture === "wiki" && snapshot?.stack !== null && snapshot?.stack !== undefined ? snapshot.stack.wiki : undefined
  if (run !== undefined) {
    return <span className="app-tile-picture" data-picture={app.picture} data-preview="run" data-testid="app-tile-preview">
      <span className="app-picture-card app-preview">
        <span className="run-outcome-dot" data-status={run.payload.phase} aria-hidden="true" />
        <span className="app-preview-title">{run.title}</span>
      </span>
      <span className="app-chip app-stamp" data-tone={phaseTone(run.payload.phase)}>{RUN_PHASE_WORDS[run.payload.phase] ?? run.payload.phase}</span>
    </span>
  }
  return <span className="app-tile-picture" data-picture={app.picture} aria-hidden="true">
    <Picture kind={app.picture} />
    {wiki !== undefined && <span className="app-chip app-stamp" data-tone={wikiTone(wiki.state)} data-testid="app-tile-wiki">{wikiRow(wiki).state} · main</span>}
  </span>
}

/** One app tile: the button door of its flow, opened without input so the flow's form renders (THE FORM LAW). */
const AppTile = ({ app, repo, workflow, onRunCommand }: {
  readonly app: HomeApp
  readonly repo: string
  readonly workflow: string | undefined
  readonly onRunCommand: RunDynamicCommand
}) => (
  <button type="button" className="app-tile" data-testid="app-tile" data-app={app.flow}
    {...dynamicFlowAction(onRunCommand, repositoryFlowName(app.flow))}>
    <AppTilePicture app={app} repo={repo} workflow={workflow} />
    <span className="app-tile-title">{app.title}</span>
  </button>
)

/** The grid of apps; every `app` block renders here, wherever the first one sits among the blocks. */
export const HomeApps = ({ apps, repo, onRunCommand }: {
  readonly apps: ReadonlyArray<HomeApp>
  readonly repo: string
  readonly onRunCommand: RunDynamicCommand
}) => {
  const controller = useContext(ControllerContext)
  return <div className="factory-home-apps" data-testid="home-apps">
    {apps.map((app) => <AppTile key={app.flow} app={app} repo={repo} onRunCommand={onRunCommand}
      workflow={controller?.commands.find(repositoryFlowName(app.flow))?.metadata.workflow ?? app.flow} />)}
  </div>
}

export const RepositoryHomeCard = ({ card, onRunCommand }: {
  readonly card: HomeCard
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const { home, flows } = card.payload
  const featuredFlows = flows.filter((flow) => flow.featured)
  if (home.kind === "error") return <p role="alert">{home.message}</p>
  if (home.kind === "none") return null
  if (home.kind === "readme") return <Markdown className="message-markdown" content={stripHomeHtml(home.markdown)} />
  const apps = homeApps(home)
  const firstApp = home.blocks.findIndex((block) => block.type === "app")
  return <div className="factory-home" data-apps={apps.length > 0 ? "true" : undefined}>{home.blocks.map((block, index) => {
    switch (block.type) {
      case "prompt": return <div key={index} className="factory-home-prompt">
        {block.title && <h1 className="factory-home-heading">{block.title}</h1>}
        <HomePrompt flow={block.flow} placeholder={block.placeholder} onRunCommand={onRunCommand} />
      </div>
      case "app": return index === firstApp ? <HomeApps key={index} apps={apps} repo={card.payload.repo} onRunCommand={onRunCommand} /> : null
      case "flows": return featuredFlows.length === 0 ? null : <div key={index}>
        {block.title && <h2>{block.title}</h2>}
        <div className="factory-home-row">{featuredFlows.map((flow) => <Button key={flow.id} type="button"
          {...dynamicFlowAction(onRunCommand, repositoryFlowName(flow.id))}>{flow.summary ?? flow.id}</Button>)}</div>
      </div>
      case "markdown": return <div key={index}>{block.title && <h2>{block.title}</h2>}
        <Markdown className="message-markdown" content={stripHomeHtml(block.markdown)} /></div>
      case "text": return <div key={index}>{block.title && <h2>{block.title}</h2>}<p>{block.text}</p></div>
      case "links": return <div key={index}>{block.title && <h2>{block.title}</h2>}
        <div className="factory-home-row">{block.links.map((link) => <a key={link.url} href={link.url}>{link.label}</a>)}</div></div>
      case "stack": return <HomeStack key={index} title={block.title} repo={card.payload.repo} onRunCommand={onRunCommand} />
    }
  })}</div>
}

export const repositoryHomeCardFamily: CardFamily<"factory.home"> = {
  "factory.home": { render: (card, actions) => <RepositoryHomeCard card={card} onRunCommand={actions.onRunCommand} />, pill: () => "" }
}
