/**
 * Build: the one page that is the chat.
 *
 * Before a turn starts the main panel is the hero (heading, composer, action
 * pills, template gallery). The first frame replaces the hero with the
 * transcript; the composer stays. `card` frames render through `PaneHost`,
 * `cell` frames as a collapsed source snippet, `call` frames as a compact
 * tool-call row.
 */
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChatComposer,
  ChatMessage,
  ChatTranscript,
  CollapsiblePanel,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FileTree,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  formatRelativeTime
} from "@smthrs/ui"
import type { AppCard } from "../../src/api.ts"
import { actionPills, buildTemplates, featuredTemplateIds } from "../../src/brand.ts"
import { chatFlowId, planFlowId, useRegistry } from "../../src/shell/registry.ts"
import type { TranscriptEntry } from "../../src/shell/store.ts"
import { actions, useAppState, useField, useSessions, useStarted } from "../../src/shell/store.ts"
import { ActionPill } from "../../src/ui/ActionPill.tsx"
import { Icon } from "../../src/ui/Icon.tsx"
import { PaneHost } from "../../src/ui/PaneHost.tsx"
import { TemplateCard } from "../../src/ui/TemplateCard.tsx"
import { htmlCardDocument } from "./htmlCardDocument.ts"

const HINT = "Enter to send · Shift+Enter newline · Esc stop · ⌘N new"
const PLACEHOLDER = "Describe an agent — e.g. hyperliquid & binance arb bot"
const TAGLINE = "Describe an agent, review the plan and files, compile, smoke-test, then ship to Projects."

const templateById = (id: string) => buildTemplates.find((template) => template.id === id)

/** Product labels, not API roles: the thread says "You" and "Aomi". */
const SPEAKER = { user: "You", assistant: "Aomi", system: "System" } as const

// ---------------------------------------------------------------------------
// Recent column
// ---------------------------------------------------------------------------

function RecentColumn() {
  const sessions = useSessions()
  const sessionId = useField("sessionId")
  const sessionsLoaded = useField("sessionsLoaded")
  const sessionsFailed = useField("sessionsFailed")
  return (
    <section className="aomi-recent" aria-label="Recent">
      {/* A plain row, like the Aomi rail: label on the left, "New" as a text
          link on the right. */}
      <div className="aomi-recent-head">
        <h2 className="aomi-recent-head-title">
          <Icon className="aomi-section-icon" name="history" size={14} />
          Recent
        </h2>
        <Button variant="ghost" size="sm" onClick={actions.newSession}>
          New
        </Button>
      </div>
      {sessions.length === 0 ? (
        sessionsLoaded && !sessionsFailed ? <EmptyState title="No runs yet" /> : null
      ) : (
        <ul className="aomi-recent-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="aomi-recent-card"
                data-active={session.id === sessionId ? "true" : undefined}
                onClick={() => actions.selectSession(session.id)}
              >
                {/* Title and pill share the first row; the stage line sits
                    under them, which is how the Aomi rail reads. */}
                <span className="aomi-recent-meta">
                  <span className="aomi-recent-title">{session.title}</span>
                  <StatusPill status={session.status} />
                </span>
                <span className="aomi-recent-stage">
                  {session.stage} · {formatRelativeTime(session.at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {sessionsFailed ? <p className="aomi-note">Couldn't load runs.</p> : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/** One mounted host per card; maximizing changes its presentation in place. */
function CardEntry({ card }: { readonly card: AppCard }) {
  const { panes } = useRegistry()
  const maximizedCardId = useField("maximizedCardId")
  switch (card.kind) {
    case "pane":
      return (
        <PaneHost
          card={card}
          panes={panes}
          maximized={maximizedCardId === card.id}
          onMaximize={actions.maximizeCard}
          onRestore={actions.restoreCard}
        />
      )

    case "html":
      return (
        <Card className="aomi-pane">
          <CardHeader className="aomi-pane-header">
            <CardTitle>{card.title ?? "Output"}</CardTitle>
          </CardHeader>
          <CardContent>
            <iframe className="aomi-html-card" title={card.title ?? "Output"} sandbox="" srcDoc={htmlCardDocument(card.html)} />
          </CardContent>
        </Card>
      )
    case "flow-run":
      return (
        <Card className="aomi-pane">
          <CardHeader className="aomi-pane-header">
            <CardTitle>{card.flowId}</CardTitle>
            <StatusPill status={card.phase} />
          </CardHeader>
          <CardContent>
            <ul className="aomi-step-list">
              {card.steps.map((step) => (
                <li key={step.name}>
                  <span>{step.name}</span>
                  <StatusPill status={step.status} />
                </li>
              ))}
            </ul>
            {card.error === undefined ? null : <p className="aomi-note">{card.error}</p>}
          </CardContent>
        </Card>
      )
    case "flow-saved":
      return (
        <Card className="aomi-pane">
          <CardHeader className="aomi-pane-header">
            <CardTitle>Saved {card.flowId}</CardTitle>
            <Badge variant="secondary">flow</Badge>
          </CardHeader>
          <CardContent>
            <p className="aomi-note">{card.description}</p>
            <FileTree nodes={card.files} />
          </CardContent>
        </Card>
      )
  }
}

function Entry({ entry, cards }: { readonly entry: TranscriptEntry; readonly cards: Readonly<Record<string, AppCard>> }) {
  switch (entry.kind) {
    case "message":
      return (
        <ChatMessage role={entry.role} label={SPEAKER[entry.role]}>
          {entry.text}
        </ChatMessage>
      )
    case "cell":
      return (
        <CollapsiblePanel title={`Cell ${entry.ordinal}`} defaultOpen={false} meta="source">
          <pre className="aomi-cell-source">
            <code>{entry.source}</code>
          </pre>
        </CollapsiblePanel>
      )
    case "call":
      return (
        <div className="aomi-call" data-outcome={entry.outcome}>
          <span className="aomi-call-flow">{entry.flow}</span>
          <StatusPill status={entry.outcome === "success" ? "ok" : "failed"} />
          {entry.message === undefined ? null : <span className="aomi-call-message">{entry.message}</span>}
        </div>
      )
    case "card": {
      const card = cards[entry.cardId]
      if (card === undefined) return null
      return <CardEntry card={card} />
    }
  }
}

function Transcript() {
  const { entries, cards, status } = useAppState()
  return (
    <ChatTranscript className="aomi-transcript" pending={status === "streaming"}>
      {entries.map((entry) => (
        <Entry key={entry.id} entry={entry} cards={cards} />
      ))}
    </ChatTranscript>
  )
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer() {
  const draft = useField("draft")
  const status = useField("status")
  const model = useField("model")
  const previewEnabled = useField("previewEnabled")
  const { flows } = useRegistry()
  return (
    <ChatComposer
      className="aomi-composer"
      aria-label="Composer"
      value={draft}
      onValueChange={actions.setDraft}
      onSubmit={(value) => void actions.submit(value, chatFlowId(flows))}
      placeholder={PLACEHOLDER}
      lifecycleStatus={status === "streaming" ? "streaming" : "ready"}
      onStop={actions.stop}
      inputAriaLabel="Describe an agent"
      // Aomi opens the composer three rows tall. The component autogrows from
      // there; `.aomi-composer` pins the floor at the same 72px.
      textareaProps={{ rows: 3 }}
      actions={
        // The toolbar slot is one flex row ending in the send button. Grouping
        // the model select and the Preview toggle lets CSS push that group to
        // the left edge, which is where the Aomi composer keeps them.
        <span className="aomi-composer-tools">
          <Select value={model} onValueChange={actions.setModel}>
            <SelectTrigger className="aomi-model-select" aria-label="Model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Aomi">Aomi</SelectItem>
            </SelectContent>
          </Select>
          <Button
            className="aomi-preview-toggle"
            variant={previewEnabled ? "default" : "ghost"}
            size="sm"
            aria-pressed={previewEnabled}
            onClick={actions.togglePreview}
          >
            <Icon name="laptop" size={14} />
            Preview
          </Button>
        </span>
      }
    />
  )
}

function ActionPills() {
  const draft = useField("draft")
  const status = useField("status")
  const { flows } = useRegistry()
  return (
    <div className="aomi-action-pills" role="group" aria-label="Quick actions">
      {actionPills.map((pill) => {
        const template = templateById(pill.action)
        // A template pill loads its prompt into the composer. "Plan from idea"
        // sends what is already there to the build pipeline flow.
        const disabled = template === undefined && (draft.trim().length === 0 || status === "streaming")
        return (
          <ActionPill
            key={pill.label}
            label={pill.label}
            {...("hint" in pill ? { hint: pill.hint } : {})}
            disabled={disabled}
            onClick={() => {
              if (template !== undefined) actions.setDraft(template.prompt)
              else void actions.submit(draft, planFlowId(flows))
            }}
          />
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function TemplateGallery() {
  const templatesOpen = useField("templatesOpen")
  const featured = featuredTemplateIds.map(templateById).filter((template) => template !== undefined)
  const pick = (id: string): void => {
    const template = templateById(id)
    if (template !== undefined) actions.setDraft(template.prompt)
    actions.closeTemplates()
  }
  return (
    <section className="aomi-templates" aria-label="Start from a template">
      {/* A heading, not a paragraph: it names the section. The label styling
          keeps it at the 12px medium weight Aomi uses. */}
      <h2 className="aomi-templates-label">
        <Icon className="aomi-section-icon" name="layout-template" size={14} />
        Start from a template
      </h2>
      <div className="aomi-template-grid">
        {featured.map((template) => (
          <TemplateCard
            key={template.id}
            id={template.id}
            title={template.title}
            description={template.description}
            onSelect={pick}
          />
        ))}
      </div>
      <div className="aomi-templates-more">
        <Button variant="ghost" size="sm" onClick={actions.openTemplates}>
          {`Browse all (${buildTemplates.length})`}
        </Button>
      </div>
      <Dialog open={templatesOpen} onOpenChange={(open) => (open ? actions.openTemplates() : actions.closeTemplates())}>
        <DialogContent className="aomi-template-drawer">
          <DialogHeader>
            <DialogTitle>Templates</DialogTitle>
            <DialogDescription>Pick one to load its prompt into the composer.</DialogDescription>
          </DialogHeader>
          <div className="aomi-template-grid">
            {buildTemplates.map((template) => (
              <TemplateCard
                key={template.id}
                id={template.id}
                title={template.title}
                description={template.description}
                onSelect={pick}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BuildPage() {
  // Subscribes to the hero-or-thread switch, not to `entries`: a streamed token
  // must not re-render the Recent column, composer and pills below.
  const started = useStarted()
  const error = useField("error")
  return (
    <div className="aomi-build">
      <RecentColumn />
      <main className="aomi-panel">
        <header className="aomi-hero">
          <p className="aomi-breadcrumb">Create</p>
          <h1 className="aomi-heading">
            <Icon className="aomi-heading-icon" name="hammer" size={20} />
            Build
          </h1>
          <p className="aomi-tagline">{TAGLINE}</p>
        </header>
        {started ? <Transcript /> : null}
        {/* The composer column is narrower than the hero, matching Aomi. */}
        <div className="aomi-column">
          <Composer />
          <ActionPills />
          <p className="aomi-hint">{HINT}</p>
          {error === undefined ? null : <p className="aomi-error">{error}</p>}
          {started ? null : <TemplateGallery />}
        </div>
      </main>
    </div>
  )
}
