import { flowAction } from "../flows/FlowAction"
/*
 * The dispatcher card (triggers.list; Factory design session 2026-09-07,
 * mock 2): the events a repository's rules wait for and the flows they
 * start, in words, for every visitor.
 *
 * Two sources, never mixed. The declared rows are the `on` table of
 * `.smithers/factory.json` read from the public mirror, each stating its
 * event in words and the flow it starts, under one pill naming where they
 * are declared. The live rows are the repository's schedules registered on
 * Smithers Cloud and exist only for a signed-in session (`live`), with their
 * state (enabled, next fire). Signed out there is no live column and no
 * placeholder for one. With nothing declared and nothing registered, the card
 * is exactly one sentence. Register is the button door of triggers.register,
 * whose requirement makes sign-in the door; a registration Smithers Cloud
 * named carries Run now, the button door of triggers.run, and behind the flow
 * builder's flag Pause beside it, the button door of triggers.pause. A row
 * stored with no registration name carries neither: both are keyed by it.
 */
import { ruleFlows } from "@smthrs/rpc/FactoryProjection"
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { flowArgs } from "../flows/FlowArgs"
import { NO_RULES_SENTENCE } from "../state/seams/TriggersSeam"
import { timeLabel as clockLabel } from "../Timestamps"
import { describeEvent, describeSchedule } from "./TriggerEvents"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"

type TriggerListCard = Extract<Card, { kind: "trigger-list" }>

export interface TriggerListCardActions {
  readonly onRunCommand: RunCommand
}

/*
 * A failed schedule request, by which request failed; the seam's words stay
 * behind Details. A preparation keeps its own named Retry (it names the
 * schedule), so its copy offers no generic one.
 */
export const TRIGGER_FAILURES: Readonly<Record<"preparation" | "pause", UserFailureCopy>> = {
  preparation: { fault: "infra", sentence: "Smithers could not prepare this schedule. Not your fault.", actions: [] },
  pause: { fault: "infra", sentence: "Smithers could not pause this schedule. Not your fault.", actions: ["retry"] }
}

/** The live state of one registered trigger, in words: only what Smithers Cloud stated. */
export const triggerStateLabel = (trigger: TriggerListCard["payload"]["triggers"][number]): string =>
  trigger.nextFireAt === undefined ? (trigger.enabled ? "enabled" : "disabled") : `${trigger.enabled ? "enabled" : "disabled"} · next ${clockLabel(trigger.nextFireAt)}`

export const TriggerListCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: TriggerListCard
} & TriggerListCardActions) => {
  const { repo, triggers } = card.payload
  const declared = card.payload.declared ?? []
  const live = card.payload.live === true
  const liveRows = live ? triggers : []
  const empty = declared.length === 0 && liveRows.length === 0
  const unreadRequest = card.payload.declared === undefined &&
    ((card.payload.preparations?.length ?? 0) > 0 || (card.payload.pauseRequests?.length ?? 0) > 0)
  return (
    <div className="world-card-list">
      {live ? <span className="world-card-path" data-testid="trigger-live">listening</span> : null}
      {empty ?
        unreadRequest ? null : <p className="smithers-card-note" data-testid="trigger-list-empty">{NO_RULES_SENTENCE}</p> :
        (
          <ul className="workflow-list" data-testid="trigger-list">
            {declared.length === 0 ? null : (
              <li className="workflow-list-row" data-testid="trigger-declared">
                <span className="world-card-path" data-testid="trigger-declared-pill">declared in .smithers/FACTORY.ts</span>
              </li>
            )}
            {declared.map((rule, index) => {
              const flows = ruleFlows(rule)
              return (
                <li key={`rule:${index}:${rule.event}`} className="workflow-list-row" data-rule={rule.event} data-source="declared">
                  <span className="workflow-list-text">
                    <strong>{describeEvent(rule.event)}</strong>
                    <span>
                      {rule.description === undefined ? `runs ${flows.join(", ")}` : `${rule.description} (${flows.join(", ")})`}
                    </span>
                  </span>
                </li>
              )
            })}
            {liveRows.map((trigger) => (
              <li key={trigger.id} className="workflow-list-row" data-trigger={trigger.id} data-enabled={trigger.enabled} data-source="box">
                <span className="workflow-list-text">
                  <strong>{describeSchedule(trigger.cron, trigger.timezone)}</strong>
                  <span>runs {trigger.flowId}</span>
                  <span data-testid={`trigger-state-${trigger.id}`}>{triggerStateLabel(trigger)}</span>
                </span>
                {trigger.slug === undefined ? null : (
                  <>
                    {trigger.enabled ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`trigger-run-${trigger.slug}`}
                        {...flowAction(onRunCommand, "triggers.run", flowArgs("triggers.run", { slug: trigger.slug, repo }))}
                      >
                        Run now
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`trigger-${trigger.enabled ? "pause" : "resume"}-${trigger.slug}`}
                      {...flowAction(onRunCommand, trigger.enabled ? "triggers.pause" : "triggers.resume",
                        trigger.enabled ? flowArgs("triggers.pause", { slug: trigger.slug, repo }) : flowArgs("triggers.resume", { slug: trigger.slug, repo }))}
                    >
                      {trigger.enabled ? "Pause" : "Resume"}
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      {(card.payload.preparations ?? []).filter(request => request.phase === "failed").map(request => (
        <FailureNotice key={request.id} role="status" className="workflow-list-row" data-testid={`trigger-preparation-failure-${request.id}`}
          failure={describedFailure("TriggerPreparationFailed", TRIGGER_FAILURES.preparation, request.error ?? "")}>
          <Button variant="ghost" size="sm" aria-label={`Retry preparation for ${request.draft.slug}`}
            {...flowAction(onRunCommand, "triggers.register", flowArgs("triggers.register", { repo, ...request.draft }))}>
            Retry
          </Button>
        </FailureNotice>
      ))}
      {(card.payload.pauseRequests ?? []).filter(request => request.phase === "failed").map(request => (
        <FailureNotice key={request.id} role="status" className="workflow-list-row" data-testid={`trigger-pause-failure-${request.id}`}
          failure={describedFailure("TriggerPauseFailed", TRIGGER_FAILURES.pause, request.error ?? "")}
          actions={{ retry: flowAction(onRunCommand, "triggers.pause", flowArgs("triggers.pause", { repo, slug: request.slug })) }} />
      ))}
      <Button
        variant="ghost"
        size="sm"
        data-testid="trigger-register"
        {...flowAction(onRunCommand, "triggers.register", repo)}
      >
        Register a rule
      </Button>
    </div>
  )
}

export const triggersCardFamily: CardFamily<"trigger-list"> = {
  "trigger-list": {
    render: (card, actions) => <TriggerListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
