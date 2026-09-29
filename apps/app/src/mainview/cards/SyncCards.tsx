import { flowAction } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"

import { Badge, Button, StatusPill } from "@smthrs/ui"
import { Check, Circle, ExternalLink, Minus, Plug, RefreshCw, X } from "lucide-react"
import { useCallback, useSyncExternalStore } from "react"
import { ageLabel, timeLabel, untilLabel } from "../Timestamps"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import type { UserFailure, UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"

export interface SyncCardActions {
  readonly onRunCommand: RunCommand
}

type ConnectorSetupCard = Extract<Card, { kind: "connector-setup" }>
type SyncOpsCard = Extract<Card, { kind: "sync-ops" }>
type RateLimit = { readonly limit: number; readonly remaining: number; readonly resetAt: string | null }

/*
 * The clock a rate-limit line reads against. A reset still ahead re-renders
 * the subscriber at each minute boundary and once more at the reset itself,
 * so `resets in 12 min` counts down and a held Retry re-enables on time. An
 * external clock subscription (useSyncExternalStore), never a lifecycle
 * effect. Each tick re-arms the next remaining-minute boundary (or reset)
 * before notifying React, and the chain stops at the reset. Unsubscribe
 * clears the current timer; the snapshot is the whole minutes left.
 */
const useClockUntil = (iso: string | null): void => {
  const at = iso === null ? Number.NaN : Date.parse(iso)
  const subscribe = useCallback((onTick: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      const remaining = at - Date.now()
      if (Number.isNaN(remaining) || remaining <= 0) return
      timer = setTimeout(() => {
        schedule()
        onTick()
      }, remaining % 60_000 || 60_000)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [at])
  const snapshot = (): number => (Number.isNaN(at) ? -1 : Math.max(0, Math.ceil((at - Date.now()) / 60_000)))
  useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * The instant a refused call's Retry waits on (ADR 0005 "Rate limits": the
 * Retry action is disabled until the reset): an exhausted budget with its
 * reset still ahead. Null when Retry may run now — a low-but-positive budget
 * shows the line and holds nothing.
 */
export const rateLimitHeldUntil = (rateLimit: RateLimit, now: number = Date.now()): number | null => {
  if (rateLimit.remaining > 0 || rateLimit.resetAt === null) return null
  const at = Date.parse(rateLimit.resetAt)
  return Number.isNaN(at) || at <= now ? null : at
}

/** The clock time a card's Retry is held until, or null when it may run; re-renders when the hold lifts. */
export const useRetryHold = (rateLimit: RateLimit | undefined): string | null => {
  useClockUntil(rateLimit?.resetAt ?? null)
  if (rateLimit === undefined) return null
  const until = rateLimitHeldUntil(rateLimit)
  return until === null ? null : timeLabel(until)
}

/** The ADR's rate-limit line; a reset ahead reads `resets in 12 min` / `resets at 12:40`, one behind `reset 4 min ago`. */
export const RateLimitLine = ({ rateLimit }: { readonly rateLimit: RateLimit }) => {
  useClockUntil(rateLimit.resetAt)
  const now = Date.now()
  const reset = rateLimit.resetAt === null
    ? ""
    : Date.parse(rateLimit.resetAt) > now
    ? ` · resets ${untilLabel(rateLimit.resetAt, now)}`
    : ` · reset ${ageLabel(rateLimit.resetAt, now)}`
  return (
    <p className="world-card-path">
      {`GitHub rate limit reached · ${rateLimit.remaining.toLocaleString()} of ${rateLimit.limit.toLocaleString()}`}
      {reset} · Retry after
    </p>
  )
}

/*
 * Why a GitHub card failed, by card and by whether GitHub named a rate limit;
 * the seam's own words stay behind Details. Re-check, Reconcile and each ref's
 * Retry already sit on the card, so the notice adds no buttons.
 */
export const SYNC_CARD_FAILURES: Readonly<Record<"setup" | "mirror", Readonly<Record<"rate-limited" | "failed", UserFailureCopy>>>> = {
  setup: {
    "rate-limited": { fault: "dependency", sentence: "GitHub is limiting requests for this repository. Not your fault.", actions: [] },
    failed: { fault: "dependency", sentence: "Smithers could not check the GitHub App for this repository. Not your fault.", actions: [] }
  },
  mirror: {
    "rate-limited": { fault: "dependency", sentence: "GitHub is limiting requests for this repository. Not your fault.", actions: [] },
    failed: { fault: "dependency", sentence: "Smithers could not sync this repository with GitHub. Not your fault.", actions: [] }
  }
}

export const SYNC_OP_FAILURE: UserFailureCopy = {
  fault: "dependency", sentence: "Smithers could not push this ref to GitHub. Not your fault.", actions: []
}

/** A card-level GitHub failure; call only when `error` is set. */
export const syncCardFailure = (card: "setup" | "mirror", payload: { readonly error?: string | undefined; readonly rateLimit?: RateLimit | undefined }): UserFailure => {
  const key = payload.rateLimit !== undefined && payload.rateLimit.remaining === 0 ? "rate-limited" : "failed"
  return describedFailure(`GitHubSync.${card}.${key}`, SYNC_CARD_FAILURES[card][key], payload.error ?? "")
}

/** The GitHub App half: install state, the install/reconcile acts, the rate-limit line. */
const GitHubSetupBody = ({ card, onRunCommand }: { readonly card: ConnectorSetupCard } & SyncCardActions) => {
  const { repo, phase, installationId, configured, installUrl } = card.payload
  const connected = phase === "connected"
  /* A refused call holds Re-check and Reconcile until the reset, with the time on them (ADR "Rate limits"). */
  const heldUntil = useRetryHold(card.payload.rateLimit)
  return (
    <div className="world-card-list">
      <div className="world-card-row">
        <span className="connect-store-icon">
          <Plug size={14} />
        </span>
        <span className="world-card-title">
          {connected
            ? `GitHub App installed${installationId != null ? ` · installation ${installationId}` : ""}${configured === true ? " · configured" : ""}`
            : "The Smithers GitHub App is not installed"}
        </span>
        <Badge variant={connected ? "success" : "outline"}>{connected ? "installed" : "not installed"}</Badge>
      </div>
      <div className="world-card-row">
        {!connected && installUrl !== undefined ?
          (
            <Button size="sm" variant="outline"  {...flowAction(onRunCommand, "github.app.open", repo)}>
              <ExternalLink size={14} /> Open GitHub
            </Button>
          ) :
          null}
        <Button size="sm" variant="ghost"  disabled={heldUntil !== null} {...flowAction(onRunCommand, "github.app", repo)}>
          <RefreshCw size={14} /> {heldUntil === null ? "Re-check" : `Re-check after ${heldUntil}`}
        </Button>
        <Button size="sm" variant="ghost"  disabled={heldUntil !== null} {...flowAction(onRunCommand, "github.reconcile", repo)}>
          {heldUntil === null ? "Reconcile" : `Reconcile after ${heldUntil}`}
        </Button>
      </div>
      {card.payload.rateLimit !== undefined ? <RateLimitLine rateLimit={card.payload.rateLimit} /> : null}
      {card.payload.error !== undefined ?
        <FailureNotice className="world-card-path" data-testid="connector-setup-failure" failure={syncCardFailure("setup", card.payload)} /> :
        null}
    </div>
  )
}

export const ConnectorSetupCardBody = ({
  card,
  onRunCommand
}: { readonly card: ConnectorSetupCard } & SyncCardActions) =>
  <GitHubSetupBody card={card} onRunCommand={onRunCommand} />

const OP_LIMIT = 10


/*
 * The endpoint name on a sync row. The wire carries whatever the backend
 * calls itself, and the cloud's own payloads still say `jjhub` — an internal
 * name the product never shows. One name reaches the screen: Smithers Cloud.
 * Every other endpoint word rides through unchanged.
 */
export const endpointLabel = (endpoint: string): string =>
  endpoint === "jjhub" || endpoint === "smithers-cloud" ? "Smithers Cloud" : endpoint

export const opGlyph = (status: string) => {
  switch (status) {
    case "success":
    case "succeeded":
    case "done":
      return <Check size={14} aria-hidden="true" />
    case "failed":
      return <X size={14} aria-hidden="true" />
    case "skipped":
      return <Minus size={14} aria-hidden="true" />
    default:
      return <Circle size={14} aria-hidden="true" fill="currentColor" />
  }
}

/**
 * The mirror header's count line (ADR 0005 `behind GitHub · 3 refs`), off
 * plue#491's `behind_refs` / `failed_refs` on the repository DTO. Null when
 * the DTO named no count — the word alone is then the whole truth, and no
 * number is invented for it.
 */
export const mirrorRefsLine = (payload: SyncOpsCard["payload"]): string | null => {
  const parts: Array<string> = []
  const { behindRefs, failedRefs } = payload
  if (behindRefs !== undefined && behindRefs > 0) parts.push(`behind GitHub · ${behindRefs} ref${behindRefs === 1 ? "" : "s"}`)
  if (failedRefs !== undefined && failedRefs > 0) parts.push(`${failedRefs} failed`)
  return parts.length === 0 ? null : parts.join(" · ")
}

export const SyncOpsCardBody = ({ card, onRunCommand }: { readonly card: SyncOpsCard } & SyncCardActions) => {
  const { subject, runId, runState, counts, mirrorStatus, trigger, ops, opsNote, expanded } = card.payload
  const shown = expanded === true ? ops : ops.slice(0, OP_LIMIT)
  const refsLine = mirrorRefsLine(card.payload)
  
  const retryFlow = "github.mirror.retry-ref"
  const retryArgs = (opId: string): string =>
    flowArgs(retryFlow, { ref: opId, repo: card.payload.repo })
  return (
    <div className="world-card-list">
      <div className="world-card-row">
        <span className="world-card-title">{subject}</span>
        {/* The run's own state word, and — for a mirror — the repository's. */}
        {runState !== null ? <StatusPill status={runState} /> : null}
        {mirrorStatus !== undefined ? <Badge variant="outline">{mirrorStatus}</Badge> : null}
      </div>
      {refsLine !== null ? <p className="world-card-path">{refsLine}</p> : null}
      {counts != null ?
        <p className="world-card-path">{`${counts.done} of ${counts.total} · ${counts.failed} failed`}</p> :
        null}
      {runId != null && trigger == null ? <p className="world-card-path">{`run ${runId}`}</p> : null}
      {trigger != null ? <p className="world-card-path">{trigger}</p> : null}
      {shown.map((op) => (
        <div key={op.id} className="world-card-row" data-testid={`sync-op-${op.id}`}>
          <span className="connect-store-icon">{opGlyph(op.status)}</span>
          <span className="world-card-title">
            {`${endpointLabel(op.source)} → ${endpointLabel(op.target)} ${op.entity}${op.entityId !== null ? ` ${op.entityId}` : ""} ${op.action}`}
          </span>
          <StatusPill status={op.status} />
          {op.at !== null ? <span className="world-card-path">{ageLabel(op.at)}</span> : null}
          {/* A failed op says so in one sentence on its own line, with Retry; its raw error stays behind Details. */}
          {op.retryable ?
            (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Retry ${op.entity} ${op.entityId ?? op.id}`}
                {...flowAction(onRunCommand, retryFlow, retryArgs(op.id))}
              >
                <RefreshCw size={14} /> Retry
              </Button>
            ) :
            null}
          {op.error !== undefined ?
            <FailureNotice role="status" className="world-card-path" data-testid={`sync-op-failure-${op.id}`}
              failure={describedFailure("SyncOpFailed", SYNC_OP_FAILURE, op.error)} /> :
            null}
        </div>
      ))}
      {ops.length > OP_LIMIT && expanded !== true ?
        (
          <div className="world-card-row">
            <Button size="sm" variant="ghost"  {...flowAction(onRunCommand, "sync.ops.show-more", card.id)}>
              {`Show more (${ops.length - OP_LIMIT})`}
            </Button>
          </div>
        ) :
        null}
      {opsNote !== undefined ? <p className="world-card-path">{opsNote}</p> : null}
      {card.payload.rateLimit !== undefined ? <RateLimitLine rateLimit={card.payload.rateLimit} /> : null}
      {card.payload.error !== undefined ?
        <FailureNotice className="world-card-path" data-testid="sync-ops-failure" failure={syncCardFailure("mirror", card.payload)} /> :
        null}
    </div>
  )
}

/* Lane sync (ADR 0005): the wizard runs, the connected state settles. */
export const syncCardFamily: CardFamily<"connector-setup" | "sync-ops"> = {
  "connector-setup": {
    render: (card, actions) => <ConnectorSetupCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: (card) => {
      if (card.payload.error !== undefined) return "failed"
      return card.payload.phase === "connected" ? "done" : "running"
    }
  },
  "sync-ops": {
    render: (card, actions) => <SyncOpsCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: (card) => {
      if (card.payload.error !== undefined) return "failed"
      
      if (card.payload.runState === null) return "pending"
      return card.payload.runState
    }
  }
}
