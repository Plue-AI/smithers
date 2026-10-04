import { EntryRow } from "./EntryRow"
import { isDesignCard } from "./state/seams/DesignWorld/subjects"
import { ViewSkeleton } from "./ViewSkeleton"
import { flowAction, flowProps } from "./flows/FlowAction"
/*
 * The card shell: header (title and actionable status), the maximize and
 * frame controls, and the body from the kind's family renderer.
 *
 * Every card body lives in a family file under ./cards and registers itself in
 * cards/CardRenderers.tsx; this file never names a card kind except for narrow presentation adaptations in the shared shell.
 */
import { Button, StatusPill } from "@smthrs/ui"
import { ArrowLeft, ArrowRight, Maximize2, Minimize2 } from "lucide-react"
import { memo, useCallback, useRef } from "react"
import type { CardActions } from "./cards/CardFamily"
import { isRetiredCard, pillStatus, renderCardBody } from "./cards/CardRenderers"
import { Component, type ErrorInfo, type ReactNode } from "react"
import { Data } from "effect"
import { failureDetail, presentUserFailure, type UserFailure, type UserFailureCopy, type UserFailureRegistry } from "@smthrs/rpc/UserFailure"
import { FailureNotice } from "./FailureNotice"

/*
 * One card's body failing to render stays inside that card: a lazy viewer
 * chunk that no longer loads (an old tab after a deploy, or the dev server
 * re-optimizing its dependencies) or a renderer that cannot read a payload.
 * Without this the error reaches the app's startup boundary and the whole
 * app reads "Smithers failed to start".
 */
/** A card viewer chunk that no longer exists: the app was updated under this tab. */
export class CardViewerOutdated extends Data.TaggedError("CardViewerOutdated")<{ readonly cause: unknown }> {}

const STALE_CHUNK = /dynamically imported module|Loading chunk|Importing a module script failed/i

const CARD_BODY_FAILURES: UserFailureRegistry<CardViewerOutdated> = {
  CardViewerOutdated: { fault: "infra", sentence: "This card's viewer changed in an update. Reload the app to see it.", actions: ["retry"] }
}

/* A renderer that cannot read its payload fails the same way after a reload, so no Reload is offered. */
const CARD_BODY_UNKNOWN: UserFailureCopy = { fault: "bug", sentence: "This card could not be shown. Not your fault.", actions: [] }

/** What one card body's render failure shows. */
export const presentCardBodyFailure = (error: unknown): UserFailure => {
  const detail = failureDetail(error)
  return presentUserFailure(CARD_BODY_FAILURES, STALE_CHUNK.test(detail) ? new CardViewerOutdated({ cause: error }) : error,
    { unknown: CARD_BODY_UNKNOWN })
}

export class CardBodyBoundary extends Component<{ readonly cardId: string; readonly onRunCommand: CardActions["onRunCommand"]; readonly children: ReactNode }, { readonly error: Error | null }> {
  override state: { readonly error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Card ${this.props.cardId} could not render`, error, info.componentStack)
  }
  override render() {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <FailureNotice failure={presentCardBodyFailure(error)} className="world-card-empty"
        actions={{ retry: { ...flowProps("chat.reload"), label: "Reload app", onClick: () => this.props.onRunCommand("chat.reload") } }} />
    )
  }
}
import type { Card } from "./state/AppState"
import { timeLabel as clockLabel } from "./Timestamps"
import { StatusDetails, statusPresentation } from "./StatusDetails"

export interface CardViewProps extends CardActions {
  readonly card: Card
  readonly maximized: boolean
  readonly onMaximize: (id: string) => void
  readonly onMinimize: () => void
  readonly onFrameBack?: () => void
  readonly onFrameForward?: () => void
  /* A maximized card's "Open in tab" (docs/LOCAL-APP.md "Cards"): user-triggered only. */
}

/*
 * Memoized: App renders the whole transcript on every streaming token, and a
 * card whose props are unchanged has nothing new to draw. Every callback comes
 * from cards/controllerCardActions.ts, built once per controller, so the default shallow
 * comparison actually bails out — the only cards that re-render are the ones
 * whose record, maximized state, verbose flag or world documents changed.
 */
export const CardView = memo(function CardView({
  card,
  maximized,
  onDecideApproval,
  onMaximize,
  onMinimize,
  onFrameBack,
  onFrameForward,
  onConnectGitHub,
  onRunWorkflow,
  onStopRun,
  onRetryRun,
  onChooseWorkflowRepo,
  worldDocuments,
  onChangeWorldDocument,
  onAttachWorldEditor,
  onRunCommand,
  debugVerbose,
  workflowCatalogs,
  triggerCatalogs,
  flowDurations,
  fileCards,
  projectionStore,
  signedOut,
  admin,
  presentation
}: CardViewProps) {
  /*
   * Maximize and minimize replace each other in the header, so the button
   * the pointer just pressed unmounts and focus falls to <body> — outside
   * the shell whose onKeyDown owns Escape. Each act hands focus to the
   * button that took its place, so Escape (and the Tab ring) keep working.
   */
  /* MOCK SEAM: a design subject card (`design:`) carries its own title, e.g. "#212 Failed webhooks are never retried". */
  const title = isDesignCard(card) ? card.title : card.kind === "repo-update" ? "Activity" :
    card.kind === "issue-list" ? (card.payload.kind === "conversation" ? "Conversations" : "Issues") : card.kind === "issue" ? (card.payload.kind === "chat" ? "Conversation" : "Issue") :
    card.kind === "pr-list" ? "Pull requests" : card.kind === "pr" ? "Pull request" : card.title
  const fallback = pillStatus(card)
  const health = card.kind === "run-trace" ? card.payload.statusRollup : undefined
  const status = statusPresentation(health, fallback).status
  const quietStatus = ["done", "completed", "succeeded", "success"].includes(status)

  const hasLocalHistory = card.navigation !== undefined && card.navigation.length > 1
  const hasRunDetails = card.kind === "run-trace"
  const statusNode = card.kind === "run-trace" ?
    <StatusDetails status={health} fallback={fallback} /> :
    fallback === "" ? null : <StatusPill status={fallback} />
  const pendingFocus = useRef<"maximize" | "minimize" | null>(null)
  // A durable command can settle after the next animation frame. Transfer
  // focus when its replacement button actually mounts, not on a guessed tick.
  const maximizeRef = useCallback((node: HTMLButtonElement | null) => {
    if (node !== null && pendingFocus.current === "maximize") {
      pendingFocus.current = null
      node.focus()
    }
  }, [])
  const minimizeRef = useCallback((node: HTMLButtonElement | null) => {
    if (node !== null && pendingFocus.current === "minimize") {
      pendingFocus.current = null
      node.focus()
    }
  }, [])
  const maximizeThenFocus = (): void => {
    pendingFocus.current = "minimize"
    onMaximize(card.id)
  }
  const minimizeThenFocus = (): void => {
    pendingFocus.current = "maximize"
    onMinimize()
  }
  if (card.kind === "retired") return card.title === "" ? null :
    <EntryRow kind="card" author={{ kind: "system", color_index: 7 }} tone="quiet"
      title={card.title} tombstone onAction={() => {}} />
  if (["balance", "billing-plans"].includes(card.kind)) return (
    <section className="smithers-card" data-kind={card.kind} data-testid={`card-${card.id}`} aria-label={card.title}>
      <header className="smithers-card-header"><span className="smithers-card-title">{card.title}</span></header>
    </section>
  )
  if (isRetiredCard(card)) return null
  return (
    <>
      {maximized ?
        (
          <div
            className="card-maximize-backdrop"
            aria-hidden="true"
            onClick={minimizeThenFocus}
          />
        ) :
        null}
      <section
        className="smithers-card"
        data-kind={card.kind}
        data-status={card.status}
        aria-busy={card.loading === true}
        data-maximized={maximized}
        data-run-id={card.kind === "run-trace" ? card.payload.runId : undefined}
        data-testid={`card-${card.id}`}
        aria-label={card.title}
        onKeyDown={(event) => {
          if (!maximized || event.key !== "Escape" || event.defaultPrevented) return
          event.preventDefault()
          event.stopPropagation()
          minimizeThenFocus()
        }}
      >
        <header className="smithers-card-header">
          {hasLocalHistory && card.navigation && <nav className="card-local-history" aria-label="Frame history">
            <button type="button"  aria-label="Back in frame" disabled={card.navigation.index === 0}
              {...flowAction(onRunCommand, "card.history.back", card.id)}><ArrowLeft size={16} /></button>
            <button type="button"  aria-label="Forward in frame" disabled={card.navigation.index + 1 === card.navigation.length}
              {...flowAction(onRunCommand, "card.history.forward", card.id)}><ArrowRight size={16} /></button>
          </nav>}
          <span className="smithers-card-title">{title}</span>
          {/* A family that has no status word for a card (a picker awaiting its human) renders no pill: "" is not a status. */}
          {!quietStatus && statusNode}
          {maximized ?
            (
              <>
                {!hasLocalHistory && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      {...flowProps("frame.back")}
                      data-testid="frame-back"
                      aria-label="Previous frame"
                      title="Previous frame"
                      onClick={() => onFrameBack?.()}
                    >
                      <ArrowLeft size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      {...flowProps("frame.forward")}
                      data-testid="frame-forward"
                      aria-label="Next frame"
                      title="Next frame"
                      onClick={() => onFrameForward?.()}
                    >
                      <ArrowRight size={13} />
                    </Button>
                  </>
                )}
                {/* Open in tab exists only on the maximized card: a user's explicit act (THE EMBED LAW). */}

                {
                  /*
                   * Ask 8 (will, 2026-09-02): "when I maximize a file I have no
                   * way of minimizing it". The way back is NAMED — an icon
                   * alone was not read as an exit — and the header it sits in
                   * sticks to the top of the scrolling card (cards.css), so it
                   * is on screen however far the body scrolls. It is the same
                   * restore flow Escape and the backdrop run.
                   */
                }
                <Button
                  ref={minimizeRef}
                  variant="ghost"
                  size="sm"
                  className="card-minimize-btn"
                  {...flowProps("card.minimize")}
                  data-testid={`card-minimize-${card.id}`}
                  aria-label="Restore"
                  title="Restore"
                  onClick={minimizeThenFocus}
                >
                  <Minimize2 size={13} />
                  Restore
                </Button>
              </>
            ) :
            (
              <Button
                ref={maximizeRef}
                variant="ghost"
                size="icon"
                className="card-maximize-btn"
                {...flowProps("card.maximize")}
                data-testid={`card-maximize-${card.id}`}
                aria-label="Maximize card"
                title="Maximize card"
                onClick={maximizeThenFocus}
              >
                <Maximize2 size={13} />
              </Button>
            )}
        </header>
        <div className="smithers-card-body">
          <CardBodyBoundary cardId={card.id} onRunCommand={onRunCommand}>
          {card.loading && card.kind !== "workspace" ? <ViewSkeleton /> : renderCardBody(card, {
            onDecideApproval,
            onConnectGitHub,
            onRunWorkflow,
            onStopRun,
            onRetryRun,
            onChooseWorkflowRepo,
            worldDocuments,
            onChangeWorldDocument,
  onAttachWorldEditor,
            onRunCommand,
            debugVerbose,
            workflowCatalogs,
            triggerCatalogs,
            flowDurations,
            fileCards,
            projectionStore,
            signedOut,
            admin,
            presentation: presentation ?? (maximized ? "maximized" : "embedded")
          })}
          </CardBodyBoundary>
        </div>
        {hasRunDetails && <details className="smithers-card-details">
          <summary aria-label={`${title} details`}>Details</summary>
          <dl>
            {quietStatus && <><dt>Status</dt><dd>{statusNode}</dd></>}
            <dt>Created</dt><dd><time dateTime={new Date(card.createdAt).toISOString()}>{clockLabel(card.createdAt)}</time></dd>
          </dl>
        </details>}
      </section>
    </>
  )
})
