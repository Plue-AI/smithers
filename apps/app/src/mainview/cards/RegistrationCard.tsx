/*
 * The Register repository app (docs/mvp/REGISTRATION.md, target
 * apps/site/public/images/app/register.png). One link field; then the run's
 * own answers: questions the workflow answered itself (violet, "Smithers
 * chose"), report tiles, and the review state. Everything shown is folded
 * from the run's journal (cards/Registration.ts); a replay re-keys the body
 * so the same recorded answers animate again, launching nothing.
 */
import { Button } from "@smthrs/ui"
import type { CSSProperties, ReactNode } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import { useController } from "../ControllerContext"
import type { Card } from "../state/AppState"
import { useCardRows } from "../state/useCardRows"
import type { CardFamily, RunCommand } from "./CardFamily"
import { outcomeOf, registrationRun, type Report, reportOf, statusOf } from "./Registration"

type RegistrationCard = Extract<Card, { kind: "registration" }>

/** Each recorded answer lands a beat after the one before. */
const BEAT_MS = 420
/** Live answers show as they arrive; a replay spaces the recorded ones out. */
const delay = (index: number): CSSProperties | undefined => index < 0 ? undefined : { animationDelay: `${index * BEAT_MS}ms` }

const Question = ({ label, options, chosen, index }: {
  readonly label: string
  readonly options: ReadonlyArray<string>
  readonly chosen: string | undefined
  readonly index: number
}) => (
  <div className="registration-question" data-state={chosen === undefined ? "pending" : "chosen"}>
    <div className="registration-label">{label}</div>
    <div className="registration-options">
      {chosen === undefined
        ? [0, 1, 2].map((key) => <span key={key} className="registration-option registration-shimmer" aria-hidden="true" />)
        : options.map((option) => (
          <span
            key={option}
            className={option === chosen ? "registration-option registration-ai" : "registration-option registration-dim"}
            style={delay(index)}
          >
            {option}
          </span>
        ))}
      {chosen === undefined ? null : <span className="registration-mark" style={delay(index)}>✦ Smithers chose</span>}
    </div>
  </div>
)

const Tile = ({ label, aside, index, children }: {
  readonly label: string
  readonly aside?: ReactNode
  readonly index: number
  readonly children: ReactNode
}) => (
  <section className="registration-tile" style={delay(index)}>
    <div className="registration-label registration-tile-head">
      <span>{label}</span>
      {aside === undefined ? null : <span>{aside}</span>}
    </div>
    {children}
  </section>
)

/** What to fix, and the one clear action that asks Smithers to fix it. */
const Fixes = ({ items, mono, prompt, repo, onRunCommand }: {
  readonly items: ReadonlyArray<string>
  readonly mono?: boolean
  readonly prompt: string
  readonly repo: string
  readonly onRunCommand: RunCommand
}) =>
  items.length === 0 ? null : (
    <>
      <ul className={mono ? "registration-fixes registration-mono" : "registration-fixes"}>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <Button size="sm" variant="solid" className="registration-fix"
        {...flowAction(onRunCommand, "change.request", flowArgs("change.request", { prompt: `Fix: ${prompt}`, repo }))}>
        Fix with Smithers
      </Button>
    </>
  )

const percent = (value: number) => `${Math.round(value * 100)}%`

const Tiles = ({ report, repo, stagger, onRunCommand }: {
  readonly report: Report
  readonly repo: string
  readonly stagger: boolean
  readonly onRunCommand: RunCommand
}) => {
  const tiles: Array<ReactNode> = []
  const next = () => stagger ? tiles.length + 4 : -1
  const commits = report.commits
  if (commits !== undefined && commits.total > 0) {
    const peak = Math.max(1, ...commits.weeks.map((week) => week.people + week.agents))
    tiles.push(
      <Tile key="commits" label="Commits · 12 weeks" index={next()}>
        <div className="registration-bars" role="img" aria-label={`${commits.total} commits in 12 weeks`}>
          {commits.weeks.map((week) => (
            <i key={week.start} style={{ height: `${((week.people + week.agents) / peak) * 100}%` }}>
              <b style={{ height: week.people + week.agents === 0 ? 0 : `${(week.agents / (week.people + week.agents)) * 100}%` }} />
            </i>
          ))}
        </div>
        <div className="registration-legend">
          <span>People</span>
          <span className="registration-legend-ai">With agents</span>
        </div>
      </Tile>
    )
  }
  const people = report.contributors
  if (people !== undefined && people.total > 0) {
    const total = people.shares.reduce((sum, count) => sum + count, 0)
    let at = 0
    const stops = people.shares.slice(0, 3).map((count, index) => {
      const from = at
      at += count / total
      return `var(--registration-slice-${index}) ${percent(from)} ${percent(at)}`
    })
    tiles.push(
      <Tile key="contributors" label="Contributors" aside={people.total} index={next()}>
        <div className="registration-row">
          <div
            className="registration-donut"
            role="img"
            aria-label={`${people.total} contributors`}
            style={{ background: `conic-gradient(${[...stops, `var(--border) ${percent(at)} 100%`].join(", ")})` }}
          />
          <div className="registration-sub">{people.core} write {percent(people.coreShare)} of commits</div>
        </div>
      </Tile>
    )
  }
  const readiness = report.readiness
  if (readiness !== undefined) {
    tiles.push(
      <Tile key="readiness" label="Agent readiness" aside={`Level ${readiness.level}`} index={next()}>
        <div className="registration-big">{readiness.score}</div>
        <div className="registration-meter"><i style={{ width: `${readiness.score}%` }} /></div>
        <Fixes
          items={readiness.fixes.map((fix) => fix.title)}
          prompt={readiness.fixes.map((fix) => fix.title).join("; ")}
          repo={repo}
          onRunCommand={onRunCommand}
        />
      </Tile>
    )
  }
  const ci = report.ci
  if (ci !== undefined) {
    tiles.push(
      <Tile key="ci" label={`CI on PR #${ci.pr}`} aside="estimate" index={next()}>
        <div className="registration-ci">
          <s>{ci.baselineMinutes} min</s>
          <span className="registration-big">{ci.estimateMinutes} min</span>
        </div>
      </Tile>
    )
  }
  const cleanup = report.cleanup
  if (cleanup !== undefined) {
    const where = (cause: typeof cleanup.causes[number]) =>
      cause.location === null ? cause.signal : `${cause.location.path}:${cause.location.line}`
    tiles.push(
      <Tile key="cleanup" label="Cleanups" aside={cleanup.status === "scored" ? `${cleanup.causes.length} to fix` : undefined} index={next()}>
        {cleanup.status === "insufficient"
          ? <div className="registration-sub">Insufficient data</div>
          : (
            <>
              <div className="registration-big">
                {cleanup.score}
                <span className="registration-sub">/100 ({cleanup.low}–{cleanup.high})</span>
              </div>
              <Fixes
                items={cleanup.causes.map(where)}
                mono
                prompt={cleanup.causes.map((cause) => `${cause.count} ${cause.signal.replace("-", " ")} findings, starting at ${where(cause)}`).join("; ")}
                repo={repo}
                onRunCommand={onRunCommand}
              />
            </>
          )}
      </Tile>
    )
  }
  const rules = report.workflows?.lintRules ?? []
  if (rules.length > 0) {
    tiles.push(
      <Tile key="lint" label="Lint rules in PRs" index={next()}>
        <div className="registration-list">
          {rules.map((rule) => (
            <div key={rule.pr}>
              <span className="registration-mono">#{rule.pr}</span>
              {rule.title}
            </div>
          ))}
        </div>
      </Tile>
    )
  }
  return tiles.length === 0 ? null : <div className="registration-tiles">{tiles}</div>
}

export const RegistrationCardBody = ({ card, onRunCommand }: {
  readonly card: RegistrationCard
  readonly onRunCommand: RunCommand
}) => {
  const controller = useController()
  const cards = useCardRows(controller.store.collections.cards)
  const { data: runs } = useLiveQuery(controller.store.collections.runtimeRuns)
  const { repo, link, error, cloudRepo, replay, startedAt } = card.payload
  const newest = registrationRun(cards, repo, runs)
  // A run from an earlier attempt is not this attempt's answer.
  const run = newest !== undefined && newest.createdAt >= startedAt ? newest : undefined
  const status = statusOf(card, run)
  const report = run === undefined ? { unavailable: [], sequences: [] } : reportOf(run)
  const outcome = run === undefined ? undefined : outcomeOf(run)
  const license = report.license?.choice
  const checks = report.checks?.choice
  const intake = report.intake?.choice
  const workflows = report.workflows === undefined ? undefined : [...report.workflows.lintRules, ...report.workflows.chores].slice(0, 3)
  const hidden = new Set(report.unavailable)
  const target = cloudRepo ?? repo
  const stagger = replay > 0
  return (
    <div
      className="registration"
      style={report.theme?.colors[0] === undefined ? undefined : { "--registration-brand": report.theme.colors[0] } as CSSProperties}
    >
      <div className="registration-link">
        <span className="registration-input registration-mono">{link}</span>
        <span className="registration-go">{status}</span>
      </div>
      {error === null ? null : <p className="registration-error">{error}</p>}
      <div key={replay} className="registration-body" data-stagger={stagger ? "" : undefined}>
        <div className="registration-questions">
          {hidden.has("license") ? null : <Question label="License" options={license?.options ?? []} chosen={license?.chosen} index={stagger ? 0 : -1} />}
          {hidden.has("checks") ? null : <Question label="Checks run on" options={checks?.options ?? []} chosen={checks?.chosen} index={stagger ? 1 : -1} />}
          {hidden.has("intake") ? null : <Question label="Contributions" options={intake?.options ?? []} chosen={intake?.chosen} index={stagger ? 2 : -1} />}
          {hidden.has("workflows") || workflows?.length === 0 ? null : (
            <Question label="Workflows to build" options={workflows?.map((pull) => pull.title) ?? []} chosen={workflows?.[0]?.title} index={stagger ? 3 : -1} />
          )}
        </div>
        <Tiles report={report} repo={target} stagger={stagger} onRunCommand={onRunCommand} />
        {outcome?.review.decision === "decline" && outcome.review.note !== "" ? <p className="registration-sub">{outcome.review.note}</p> : null}
        {status === "Ready" ? <Button size="sm" {...flowAction(onRunCommand, "repo.select", target)}>Open</Button> : null}
      </div>
    </div>
  )
}

export const registrationCardFamily: CardFamily<"registration"> = {
  registration: {
    render: (card, actions) => <RegistrationCardBody card={card} onRunCommand={actions.onRunCommand} />,
    // The status word shows once, on the link row and the status row; the header carries only the title.
    pill: () => ""
  }
}
