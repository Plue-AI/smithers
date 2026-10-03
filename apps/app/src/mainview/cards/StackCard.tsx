import { useClock } from "@smthrs/ui/clock"
/*
 * The History card (epic #1745, D-20): one repository's mythical stack, which
 * is its history of logical changes, live, read as the factory's issue list.
 * The measured numbers first, then the issues grouped Needs you / Working /
 * Done (StackIssues.ts), then counts (landed, and whether main moved past the
 * stack), the lanes against maxParallel, and the stack's changes, each row
 * naming its issue or change, where it is, its checks and its pull request.
 * The metrics view (`history.view`) is the same numbers over a table of the
 * settled issues. Every button is a
 * registered flow. The same body renders in the chat, maximized, and on the
 * repository homepage (`S.Home.Stack`); the snapshot is the stack seam's live
 * read, never card state.
 */
import { type MythicalItem, type MythicalItemState, type MythicalStack, type MythicalWiki, mythicalMachine, mythicalReceiptDuration } from "@smthrs/rpc/Mythical"
import { Button } from "@smthrs/ui"
import { useContext, useSyncExternalStore } from "react"
import { ControllerContext } from "../ControllerContext"
import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import type { Card } from "../state/AppState"
import type { StackSnapshot } from "../state/seams/StackSeam"
import { elapsedLabel } from "../Timestamps"
import type { CardFamily, RunCommand } from "./CardFamily"
import type { IssueGroup } from "@smthrs/rpc/StackIssues"
import { issueGroups, issueProgress, issueWord, settledItems, spanLabel, stackMetricLabels, stackMetrics, issueToLandedMs } from "@smthrs/rpc/StackIssues"
import { accountLabel, ACTIVE_ITEM_STATES, itemReason, itemStateLabel, itemTitle, landable, laneRows, retryable, stackCounts, stackRows, wikiRow } from "@smthrs/rpc/StackView"

type StackCard = Extract<Card, { kind: "stack" }>
type Failure = NonNullable<StackCard["payload"]["failure"]>
type View = NonNullable<StackCard["payload"]["view"]>

const NO_SNAPSHOTS = { get: () => undefined, subscribe: () => () => {} }

/** The seam's live snapshot of one repository; absent outside a controller. */
export const useStackSnapshot = (repo: string): StackSnapshot | undefined => {
  const snapshots = useContext(ControllerContext)?.stackSnapshots ?? NO_SNAPSHOTS
  return useSyncExternalStore(snapshots.subscribe, () => snapshots.get(repo), () => snapshots.get(repo))
}

const Title = ({ stack, item }: { readonly stack: MythicalStack; readonly item: MythicalItem }) =>
  item.issue === undefined ? <span className="world-card-title">{itemTitle(stack, item)}</span> : (
    <a href={item.issue.url} target="_blank" rel="noopener noreferrer" className="world-card-title">{itemTitle(stack, item)}</a>
  )

const Checks = ({ item }: { readonly item: MythicalItem }) => {
  if (item.checks === undefined) return null
  if (item.checks.state === "failed") {
    return <span className="world-card-path" data-checks="failed">✗ {item.checks.failed.join(", ")}</span>
  }
  return <span className="world-card-path" data-checks={item.checks.state}>{item.checks.state === "passed" ? "✓" : "…"}</span>
}

/**
 * One line per check receipt on the candidate: its mark, its check (opening
 * the run that recorded it, when the receipt names one) and how long it ran;
 * a check still running reads pending.
 */
const Receipts = ({ item, repo, onRunCommand }: {
  readonly item: MythicalItem
  readonly repo: string
  readonly onRunCommand: RunCommand
}) => {
  const receipts = item.checks?.receipts ?? []
  if (receipts.length === 0 && item.checks?.state !== "pending") return null
  return (
    <ul className="stack-receipts" data-testid={`stack-item-${item.id}-receipts`}>
      {receipts.map((receipt) => {
        const took = mythicalReceiptDuration(receipt)
        return (
          <li key={`${receipt.check}-${receipt.commit}`} className="world-card-path" data-receipt={receipt.status}>
            {receipt.status === "passed" ? "✓" : "✗"} {receipt.runId === undefined ? receipt.check : (
              <button type="button" className="thread-ref"
                {...flowAction(onRunCommand, "runs.open", flowArgs("runs.open", { runId: receipt.runId, repo }))}>{receipt.check}</button>
            )}{took === undefined ? null : ` ${took}`}
          </li>
        )
      })}
      {item.checks?.state === "pending" ? <li className="world-card-path" data-receipt="pending">… pending</li> : null}
    </ul>
  )
}

/** The machine the item's lane runs on: its kind and image. */
const Machine = ({ item }: { readonly item: MythicalItem }) => {
  const machine = mythicalMachine(item.placement)
  return machine === undefined ? null
    : <span className="world-card-path" data-testid={`stack-item-${item.id}-machine`}>{machine}</span>
}

const ItemCells = ({ item, repo, onRunCommand, retry = true, reason, progress }: {
  readonly item: MythicalItem
  readonly repo: string
  readonly onRunCommand: RunCommand
  /** The issue row owns Retry; a change row of the same item does not repeat it. */
  readonly retry?: boolean
  /** The line under the row, when it says more than the row's word. */
  readonly reason: string | undefined
  /** The issue row's current plan, omitted from its matching stack-change row. */
  readonly progress?: string
}) => (
    <>
      <Checks item={item} />
      {item.pullRequest === undefined ? null : (
        <a href={item.pullRequest.url} target="_blank" rel="noopener noreferrer" className="world-card-path">PR #{item.pullRequest.number}</a>
      )}
      {retry && landable(item) ? (
        <Button size="sm" variant="ghost"
          {...flowAction(onRunCommand, "history.land", flowArgs("history.land", { id: item.id, head: item.pullRequest!.head!, repo }))}>Land</Button>
      ) : null}
      {progress === undefined ? null : <span className="world-card-path" data-testid={`stack-item-${item.id}-progress`}>{progress}</span>}
      {retry && retryable(item) ? (
        <Button size="sm" variant="ghost"
          {...flowAction(onRunCommand, "history.retry", flowArgs("history.retry", { id: item.id, repo }))}>Retry</Button>
      ) : null}
      {reason === undefined ? null : <ItemReason item={item} reason={reason} />}
    </>
)

/*
 * What a row's reason line is, by the item's state: the planner's own words to
 * a person (shown as is), a stop whose sentence is ours (the server's words
 * behind Details), or a note on a moving change (behind Details, the row's
 * state word being its sentence).
 */
const ITEM_REASONS: Readonly<Record<MythicalItemState, UserFailureCopy | "words" | "note">> = {
  skipped: "words",
  declined: "words",
  queued: "note",
  running: "note",
  delivering: "note",
  integrating: "note",
  verifying: "note",
  proposing: "note",
  waiting: "note",
  proposed: "note",
  landed: "note",
  cancelled: { fault: "user", sentence: "The issue closed before work started.", actions: [] },
  rejected: { fault: "user", sentence: "Its pull request closed without merging.", actions: [] },
  retrying: { fault: "infra", sentence: "A conflict or failed check sent this back to a lane. Not your fault.", actions: [] },
  blocked: { fault: "infra", sentence: "Smithers ran out of attempts on this issue. Not your fault.", actions: [] },
  unknown: { fault: "bug", sentence: "Smithers stopped this change for a reason it could not read. Not your fault.", actions: [] }
}

const ItemReason = ({ item, reason }: { readonly item: MythicalItem; readonly reason: string }) => {
  // A typed failure's sentence is the server's, the same on every surface.
  if (item.failure !== undefined) {
    return <FailureNotice role="status" className="world-card-path stack-reason" data-testid={`stack-item-${item.id}-reason`}
      failure={{ tag: `stack.item.${item.failure.kind}`, fault: item.failure.fault, sentence: reason, actions: [], detail: "" }} />
  }
  // Conflict paths are the stack's own structured words, never server prose.
  const conflict = item.state === "retrying" && (item.integration?.conflict?.paths ?? []).length > 0
  const kind = conflict ? "words" : ITEM_REASONS[item.state]
  if (kind === "words") return <span className="world-card-path stack-reason">{reason}</span>
  if (kind === "note") {
    return <details className="world-card-path stack-reason"><summary>Details</summary><pre tabIndex={0}>{reason}</pre></details>
  }
  return <FailureNotice role="status" className="world-card-path stack-reason" data-testid={`stack-item-${item.id}-reason`}
    failure={describedFailure(`stack.item.${item.state}`, kind, reason)} />
}

const StateWord = ({ item, word = itemStateLabel(item) }: { readonly item: MythicalItem; readonly word?: string }) =>
  <span className="stack-state" data-state={item.state}>{word}</span>

/**
 * One issue: glyph, `#n title`, one word (Needs you: why; Working: its clock
 * since it last moved), its checks, PR and Retry, and the reason line.
 */
const IssueRow = ({ stack, group, item, repo, now, onRunCommand }: {
  readonly stack: MythicalStack
  readonly group: IssueGroup
  readonly item: MythicalItem
  readonly repo: string
  readonly now: number
  readonly onRunCommand: RunCommand
}) => {
  const clock = group.id === "working" && ACTIVE_ITEM_STATES.has(item.state) ? elapsedLabel(item.updatedAt, now) : undefined
  const word = group.id === "needs-you" ? issueWord(item) : itemStateLabel(item)
  return (
    <li className="world-card-row" data-testid={`stack-item-${item.id}`} data-group={group.id}>
      <span className="stack-glyph" data-group={group.id} data-state={item.state} aria-hidden="true">{group.glyph}</span>
      <Title stack={stack} item={item} />
      {clock === undefined ? <StateWord item={item} word={word} /> : (
        <time className="world-card-path" dateTime={item.updatedAt} data-testid={`stack-item-${item.id}-elapsed`}>{clock}</time>
      )}
      <ItemCells item={item} repo={repo} onRunCommand={onRunCommand} reason={group.id === "needs-you" ? undefined : itemReason(item)} progress={issueProgress(item)} />
      <Receipts item={item} repo={repo} onRunCommand={onRunCommand} />
      <Machine item={item} />
    </li>
  )
}

const IssueGroups = ({ stack, repo, now, onRunCommand }: {
  readonly stack: MythicalStack
  readonly repo: string
  readonly now: number
  readonly onRunCommand: RunCommand
}) => (
  <>
    {issueGroups(stack, now).map((group) => (
      <section key={group.id} className="stack-group" aria-labelledby={`stack-group-${group.id}`} data-testid={`stack-group-${group.id}`}>
        <h3 className="stack-group-head" id={`stack-group-${group.id}`}>
          <span className="stack-glyph" data-group={group.id} aria-hidden="true">{group.glyph}</span>
          <span>{group.label}</span>
          <span data-testid={`stack-group-${group.id}-count`}>{group.items.length}</span>
        </h3>
        {group.items.length === 0 ? null : (
          <ol className="stack-rows">
            {group.items.map((item) => (
              <IssueRow key={item.id} stack={stack} group={group} item={item} repo={repo} now={now} onRunCommand={onRunCommand} />
            ))}
          </ol>
        )}
      </section>
    ))}
  </>
)

/** The measured numbers, number first, and the two views of the card. */
const MetricsLine = ({ stack, repo, view, onRunCommand }: {
  readonly stack: MythicalStack
  readonly repo: string
  /** Absent on the homepage, which has no card to switch: no switch. */
  readonly view: View | undefined
  readonly onRunCommand: RunCommand
}) => {
  const metrics = stackMetrics(stack)
  return (
    <div className="world-card-row stack-metrics" data-testid="stack-metrics">
      {stackMetricLabels(metrics).map(({ id, text }) => <span key={id} data-testid={`stack-metric-${id}`}>{text}</span>)}
      {view === undefined ? null : (
        <span className="stack-views">
          {(["issues", "metrics"] as const).map((next) => (
            <Button key={next} size="sm" variant={next === view ? "secondary" : "ghost"} aria-pressed={next === view}
              {...flowAction(onRunCommand, "history.view", flowArgs("history.view", { view: next, repo }))}>
              {next === "issues" ? "Issues" : "Metrics"}
            </Button>
          ))}
        </span>
      )}
    </div>
  )
}

/** The settled issues: outcome, issue→landed where the item carries its first-observed stamp, route and attempt. */
const MetricsTable = ({ stack }: { readonly stack: MythicalStack }) => {
  const items = settledItems(stack)
  if (items.length === 0) return null
  const spans = new Map(items.map((item) => [item.id, issueToLandedMs(item)]))
  const timed = [...spans.values()].some((ms) => ms !== undefined)
  const costed = items.some((item) => item.costNanos !== undefined)
  const edited = items.some((item) => item.humanEdited !== undefined)
  const planned = items.some((item) => item.todo !== undefined)
  const routed = items.some((item) => item.route !== undefined)
  return (
    <table className="secrets-table" aria-label="Settled issues" data-testid="stack-metrics-table">
      <thead>
        <tr>
          <th scope="col">Issue</th>
          <th scope="col">Outcome</th>
          {timed ? <th scope="col">Issue→landed</th> : null}
          {costed ? <th scope="col">Cost</th> : null}
          {edited ? <th scope="col">Edited</th> : null}
          {planned ? <th scope="col">Replans</th> : null}
          {routed ? <th scope="col">Route</th> : null}
          <th scope="col">Attempt</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const ms = spans.get(item.id)
          return (
            <tr key={item.id} data-testid={`stack-metrics-${item.id}`}>
              <td><Title stack={stack} item={item} /></td>
              <td><StateWord item={item} /></td>
              {timed ? <td>{ms === undefined ? null : spanLabel(ms)}</td> : null}
              {costed ? <td>{item.costNanos === undefined ? null : `$${(item.costNanos / 1_000_000_000).toFixed(2)}`}</td> : null}
              {edited ? <td>{item.humanEdited === true ? "you" : "–"}</td> : null}
              {planned ? <td>{item.todo?.replans}</td> : null}
              {routed ? <td>{item.route?.as}</td> : null}
              <td>{item.attempt}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* A failed Wiki refresh: our sentence, the refresh's own words behind Details. */
const WIKI_FAILED: UserFailureCopy = { fault: "infra", sentence: "Smithers could not refresh the Wiki. Not your fault.", actions: ["retry"] }

/** The repository Wiki the stack keeps current: its state, its pages (the cloud Wiki), and Retry when a refresh failed. */
const WikiRow = ({ wiki, repo, onRunCommand }: {
  readonly wiki: MythicalWiki
  readonly repo: string
  readonly onRunCommand: RunCommand
}) => {
  const row = wikiRow(wiki)
  return (
    <div className="world-card-row stack-wiki" data-testid="stack-wiki">
      <span>Wiki</span>
      <span className="stack-state" data-state={row.state}>{row.state}</span>
      <Button size="sm" variant="ghost" data-testid="stack-wiki-pages" {...flowAction(onRunCommand, "wiki.cloud", repo)}>{row.pages}</Button>
      {row.edited === undefined ? null : <span className="world-card-path" data-testid="stack-wiki-edited">{row.edited}</span>}
      {row.failure === undefined ? null : (
        <FailureNotice className="world-card-path stack-reason" data-testid="stack-wiki-failure"
          failure={describedFailure("stack.wiki", WIKI_FAILED, row.failure)}
          actions={{ retry: flowAction(onRunCommand, "wiki.create", repo) }} />
      )}
    </div>
  )
}

const RETRY_FLOW = { bootstrap: "history.bootstrap", backfill: "history.backfill", parallel: "history.parallel", retry: "history.retry", todo: "todo.new" } as const

/* What each stack act's failure says; the seam's own words stay behind Details. */
const STACK_ACT_FAILURES: Readonly<Record<Failure["act"] | "read", UserFailureCopy>> = {
  bootstrap: { fault: "infra", sentence: "Smithers could not create this history.", actions: ["retry"] },
  backfill: { fault: "infra", sentence: "Smithers could not backfill open issues.", actions: ["retry"] },
  parallel: { fault: "infra", sentence: "Smithers could not change the number of lanes.", actions: ["retry"] },
  retry: { fault: "infra", sentence: "Smithers could not retry this change.", actions: ["retry"] },
  todo: { fault: "infra", sentence: "Smithers could not add this TODO.", actions: ["retry"] },
  read: { fault: "infra", sentence: "Smithers could not read this history.", actions: ["retry"] }
}

/* A stored act failure: its act picks the sentence, its text is only ever the detail. */
const storedFailure = (stored: Failure) => ({ act: stored.act, args: stored.args, detail: stored.message })

const FailureRow = ({ detail, act, args, onRunCommand }: {
  readonly detail: string
  readonly act: Failure["act"] | "read"
  readonly args: string
  readonly onRunCommand: RunCommand
}) => (
  <FailureNotice className="world-card-row stack-failure" data-testid="stack-failure" data-act={act}
    failure={describedFailure(`stack.${act}`, STACK_ACT_FAILURES[act], detail)}
    actions={{ retry: flowAction(onRunCommand, act === "read" ? "history.show" : RETRY_FLOW[act], args) }} />
)

/** Below the issues: the stack's size, main and lanes, the admin doors, the Wiki, the lanes and the stack's changes tip first. */
const StackMachinery = ({ stack, repo, now, onRunCommand }: {
  readonly stack: MythicalStack
  readonly repo: string
  readonly now: number
  readonly onRunCommand: RunCommand
}) => {
  const counts = stackCounts(stack)
  return (
    <>
      <p className="world-card-row stack-counts" data-testid="stack-counts">
        <span>{counts.changes} {counts.changes === 1 ? "change" : "changes"}</span>
        {stack.mainBehind ? <span data-testid="stack-main-behind">main ahead</span> : null}
        <span data-testid="stack-lane-count">{counts.busy}/{counts.maxParallel} lanes</span>
      </p>
      <div className="world-card-row stack-admin">
        <Button size="sm" data-testid="stack-todo" {...flowAction(onRunCommand, "todo.new", flowArgs("todo.new", {}))}>New TODO</Button>
        <Button size="sm" variant="ghost" {...flowAction(onRunCommand, "history.backfill", repo)}>Backfill</Button>
        <Button size="sm" variant="ghost" aria-label="Fewer lanes" disabled={counts.maxParallel <= 1}
          {...flowAction(onRunCommand, "history.parallel", flowArgs("history.parallel", { value: counts.maxParallel - 1, repo }))}>−</Button>
        <span data-testid="stack-max-parallel">{counts.maxParallel}</span>
        <Button size="sm" variant="ghost" aria-label="More lanes" disabled={counts.maxParallel >= 8}
          {...flowAction(onRunCommand, "history.parallel", flowArgs("history.parallel", { value: counts.maxParallel + 1, repo }))}>+</Button>
      </div>
      {stack.wiki === undefined ? null : <WikiRow wiki={stack.wiki} repo={repo} onRunCommand={onRunCommand} />}
      <ol className="stack-lanes" aria-label="Lanes" data-testid="stack-lanes">
        {laneRows(stack).map(({ index, workspaceId, item, lane }) => {
          const startedAt = lane?.startedAt
          const elapsed = startedAt === undefined ? undefined : elapsedLabel(startedAt, now)
          return (
            <li key={index} className="world-card-row" data-testid={`stack-lane-${index}`}>
              <span className="world-card-path">{index + 1}</span>
              {item === undefined ? <span className="world-card-path">idle</span> : (
                <>
                  <Title stack={stack} item={item} />
                  <span className="stack-state" data-state={item.state}>{itemStateLabel(item)}</span>
                  {elapsed === undefined ? null : (
                    <time className="world-card-path" dateTime={startedAt} data-testid={`stack-lane-${index}-elapsed`}>{elapsed}</time>
                  )}
                  {lane?.account === undefined ? null : (
                    <span className="world-card-path" data-testid={`stack-lane-${index}-account`}
                      data-provider={lane.account.provider}>{accountLabel(lane.account)}</span>
                  )}
                  {lane?.seat === undefined ? null : <span className="world-card-path" data-testid={`stack-lane-${index}-seat`}>{lane.seat}</span>}
                </>
              )}
              {workspaceId === undefined ? null : <span className="world-card-path">{workspaceId.slice(0, 8)}</span>}
            </li>
          )
        })}
      </ol>
      <ol className="stack-rows" aria-label="Stack" data-testid="stack-rows">
        {stackRows(stack).flatMap((row) => row.kind === "item" ? [] : [(
          <li key={row.key} className="world-card-row" data-testid={`stack-change-${row.change.changeId}`}>
            {row.item === undefined ? <span className="world-card-title">{row.change.title}</span> : <Title stack={stack} item={row.item} />}
            <span className="world-card-path">{row.change.changeId.slice(0, 8)}</span>
            {row.item !== undefined ? (
              <>
                <StateWord item={row.item} />
                <ItemCells item={row.item} repo={repo} onRunCommand={onRunCommand} retry={false} reason={itemReason(row.item)} />
              </>
            ) : row.change.state === "pending" ? <span className="stack-state" data-state="pending">pending</span> : null}
          </li>
        )])}
      </ol>
    </>
  )
}

export interface StackBodyProps {
  readonly repo: string
  readonly snapshot: StackSnapshot | undefined
  readonly failure: Failure | null
  readonly bootstrapping: boolean
  /** The card's view; absent on the homepage block, which is always the issue list and draws no switch. */
  readonly view?: View | undefined
  readonly onRunCommand: RunCommand
}

export const StackBody = ({ repo, snapshot, failure, bootstrapping, view, onRunCommand }: StackBodyProps) => {
  const stack = snapshot?.stack ?? null
  const running = stack !== null && stack.items.some((item) => ACTIVE_ITEM_STATES.has(item.state))
  const now = useClock(running)
  const failures = (
    <>
      {failure === null ? null : <FailureRow {...storedFailure(failure)} onRunCommand={onRunCommand} />}
      {snapshot?.error == null ? null : <FailureRow detail={snapshot.error} act="read" args={repo} onRunCommand={onRunCommand} />}
    </>
  )
  if (stack === null || stack.state === "absent") {
    return (
      <div className="world-card-list" data-testid="stack-card">
        {failures}
        {stack === null || bootstrapping ? null : (
          <Button size="sm" data-testid="stack-bootstrap" {...flowAction(onRunCommand, "history.bootstrap", repo)}>Bootstrap</Button>
        )}
      </div>
    )
  }
  return (
    <div className="world-card-list" data-testid="stack-card" data-stack-state={stack.state}>
      {failures}
      {stack.state === "frozen" ? <p role="alert" data-testid="stack-frozen">{stack.reason ?? "frozen"}</p> : null}
      <MetricsLine stack={stack} repo={repo} view={view} onRunCommand={onRunCommand} />
      {view === "metrics" ? <MetricsTable stack={stack} /> : (
        <>
          <IssueGroups stack={stack} repo={repo} now={now} onRunCommand={onRunCommand} />
          <StackMachinery stack={stack} repo={repo} now={now} onRunCommand={onRunCommand} />
        </>
      )}
    </div>
  )
}

/** The chat card: the seam's live snapshot beside the card's own failure and request. */
export const StackCardBody = ({ card, onRunCommand }: { readonly card: StackCard; readonly onRunCommand: RunCommand }) => {
  const snapshot = useStackSnapshot(card.payload.repo)
  return <StackBody repo={card.payload.repo} snapshot={snapshot} failure={card.payload.failure}
    bootstrapping={card.payload.bootstrap !== undefined} view={card.payload.view ?? "issues"} onRunCommand={onRunCommand} />
}

/** The homepage block: the same body, read-only of card state. */
export const HomeStack = ({ title, repo, onRunCommand }: {
  readonly title?: string | undefined
  readonly repo: string
  readonly onRunCommand: RunCommand
}) => {
  const snapshot = useStackSnapshot(repo)
  // Signed out (no read) or before the first answer, the block is absent.
  if (snapshot === undefined) return null
  return <div data-testid="home-stack">{title && <h2>{title}</h2>}
    <StackBody repo={repo} snapshot={snapshot} failure={null} bootstrapping={false} onRunCommand={onRunCommand} /></div>
}

export const stackCardFamily: CardFamily<"stack"> = {
  stack: {
    render: (card, actions) => <StackCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: () => ""
  }
}
