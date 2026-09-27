import { flowArgs } from "../flows/FlowArgs"
import { flowAction, flowProps } from "../flows/FlowAction"
/*
 * The repo-import card: one upserted job card, phase starting → running →
 * done | failed. The frame's StatusPill wears the coarse state; the body
 * names the exact phase, the live stage detail, the job's own progress
 * counts when the wire carries them, and — on a failure — one retry act
 * (repos.import.retry when the job id is known). The done state opens the
 * repository's issues through the same product session; a refused GitHub call's rate-limit line
 * follows ADR 0005.
 */
import { Badge, Button } from "@smthrs/ui"
import { CloudDownload, RefreshCw } from "lucide-react"
import type { Card } from "../state/AppState"
import { REPO_IMPORT_LOST_STREAM_DETAIL } from "../state/seams/RepoImportSeam"
import { RateLimitLine, useRetryHold } from "./SyncCards"
import type { CardFamily, RunCommand } from "./CardFamily"

const PHASE_VARIANT = {
  starting: "outline",
  running: "outline",
  done: "success",
  failed: "destructive"
} as const

export const RepoImportCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "repo-import" }>
  readonly onRunCommand: RunCommand
}) => {
  const { repo, jobId, phase, detail, stage, counts, repository, rateLimit } = card.payload
  /* A refused GitHub call holds Try again until the reset, with the time on it (ADR 0005 "Rate limits"). */
  const heldUntil = useRetryHold(rateLimit)
  return (
    <div className="world-card-list">
      <div className="world-card-row">
        <span className="connect-store-icon">
          <CloudDownload size={14} />
        </span>
        <span className="world-card-title">{repo}</span>
        <Badge variant={PHASE_VARIANT[phase]}>{phase}</Badge>
      </div>
      {detail !== null ? <p className="world-card-path">{detail}</p> : null}
      {counts !== undefined ?
        (
          <p className="world-card-path">
            {`refs ${counts.refs.done} of ${counts.refs.total} · objects ${counts.objects.done} of ${counts.objects.total} · issues ${counts.issues.done} of ${counts.issues.total}`}
          </p>
        ) :
        null}
      {/* ADR 0005: `stage · provisioning_workspace` — the job's own word, never translated. */}
      {stage != null ? <p className="world-card-path">{`stage · ${stage}`}</p> : null}
      {phase === "done" && repository != null ?
        <p className="world-card-path">{`${repository.owner}/${repository.name}`}</p> :
        null}
      {phase === "done" ?
        (
          <div className="world-card-row">
            <Button
              size="sm"
              variant="outline"
              {...flowAction(onRunCommand, "issues.list", flowArgs("issues.list", { repo: repository ? `${repository.owner}/${repository.name}` : repo }))}
            >
              Show issues
            </Button>
          </div>
        ) :
        null}
      {rateLimit !== undefined ? <RateLimitLine rateLimit={rateLimit} /> : null}
      {phase === "failed" || (phase === "running" && detail === REPO_IMPORT_LOST_STREAM_DETAIL) ?
        (
          <div className="world-card-row">
            <Button
              size="sm"
              variant="outline"
              {...flowProps(jobId !== null ? "repos.import.retry" : "repos.import")}
              disabled={heldUntil !== null}
              onClick={() => (jobId !== null ? onRunCommand("repos.import.retry", jobId) : onRunCommand("repos.import", repo))}
            >
              <RefreshCw size={14} /> {heldUntil === null ? "Try again" : `Try again after ${heldUntil}`}
            </Button>
          </div>
        ) :
        null}
    </div>
  )
}

export const repoImportCardFamily: CardFamily<"repo-import"> = {
  "repo-import": {
    render: (card, actions) => <RepoImportCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: (card) => {
      if (card.payload.phase === "starting") return "starting"
      if (card.payload.phase === "done") return "done"
      if (card.payload.phase === "failed") return "failed"
      return "running"
    }
  }
}
