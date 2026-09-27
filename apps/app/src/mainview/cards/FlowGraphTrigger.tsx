/*
 * The trigger panel: what Smithers Cloud says about the schedules that fire
 * this flow (L6; D-031 for the node, D-043 for the schedule).
 *
 * A registration carries its slug, cron, zone, whether it is enabled and its
 * next fire, and nothing else — so the panel shows nothing else. Its doors
 * are `triggers.run` and `triggers.pause`/`triggers.resume`, keyed by that
 * slug; a row stored before registrations named one has no door.
 */
import { Button } from "@smthrs/ui"
import { flowAction } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import type { RunCommand } from "./CardFamily"
import { describeSchedule } from "./TriggerEvents"
import { nextFireTimes, type TriggerFireTime, type TriggerGraphNode } from "./FlowGraphTriggerNode"

/**
 * One instant, in the schedule's zone beside UTC when the two differ.
 *
 * The UTC reading says so. The zoned one does not repeat the zone it is in:
 * the schedule's own line above already states it, once.
 */
const Reading = ({ time }: { readonly time: TriggerFireTime }) => (
  <>
    {time.zoned === undefined ? null : <span className="flow-trigger-zoned">{time.zoned}</span>}
    <span className="flow-trigger-utc">{`${time.utc} UTC`}</span>
  </>
)

/** One schedule, as the panel beside the graph shows it. */
const TriggerPane = ({
  trigger,
  repo,
  onRunCommand
}: {
  readonly trigger: TriggerGraphNode
  readonly repo: string
  readonly onRunCommand: RunCommand
}) => {
  const { row, state } = trigger
  const fires = nextFireTimes(row)
  const slug = row.slug
  return (
    <li className="flow-trigger" data-trigger={row.id} data-trigger-state={state}>
      <div className="flow-trigger-head">
        <strong data-testid={`trigger-schedule-${row.id}`}>{describeSchedule(row.cron, row.timezone)}</strong>
        <span className="flow-trigger-word">{state}</span>
      </div>
      {fires.length === 0 ? null : (
        <ol className="flow-trigger-fires" data-testid={`trigger-fires-${row.id}`}>
          {fires.map((time) => <li key={time.at}><Reading time={time} /></li>)}
        </ol>
      )}
      {slug === undefined ? null : (
        <span className="flow-trigger-doors">
          {row.enabled ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`trigger-run-${slug}`}
              {...flowAction(onRunCommand, "triggers.run", flowArgs("triggers.run", { slug, repo }))}
            >
              Run now
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            data-testid={`trigger-${row.enabled ? "pause" : "resume"}-${slug}`}
            {...flowAction(onRunCommand, row.enabled ? "triggers.pause" : "triggers.resume",
                row.enabled ? flowArgs("triggers.pause", { slug, repo }) : flowArgs("triggers.resume", { slug, repo }))}
          >
            {row.enabled ? "Pause" : "Resume"}
          </Button>
        </span>
      )}
    </li>
  )
}

/**
 * The schedules that fire one flow, beside its graph.
 *
 * No schedule fires this flow means no panel: an empty region with a heading
 * over it would be a claim that something was read and found to be nothing,
 * which a plan card cannot make.
 */
export const FlowGraphTrigger = ({
  triggers,
  repo,
  onRunCommand
}: {
  readonly triggers: ReadonlyArray<TriggerGraphNode>
  readonly repo: string
  readonly onRunCommand: RunCommand
}) => {
  if (triggers.length === 0) return null
  return (
    <ul className="flow-trigger-panel">
      {triggers.map((trigger) => (
        <TriggerPane key={trigger.id} trigger={trigger} repo={repo} onRunCommand={onRunCommand} />
      ))}
    </ul>
  )
}
