/*
 * The GitHub side of J10, outside the product: a pull request as GitHub shows
 * it, rendered from the same world, so every sync is visible from both ends.
 * Neutral styling on purpose: it stands for GitHub, it doesn't copy it.
 * Smithers writes the body (spec §12.5.1) and rewrites it on every revision,
 * from the receipt the TODO card shows: the latest prompt, its acceptance,
 * this revision's checks, diff stat and review, the earlier items it includes
 * until they merge, a link back and who requested it.
 */
import { Fragment } from "react"
import { member, openItems, refOf, type ActorId, type Evidence, type State, type Todo } from "./world"
import { typedOr, type FrameValue } from "./frame"
import { GitHubMark } from "./parts"

const login = (state: State, who: ActorId | string): string => member(state.world, who)?.login ?? who

const RESULT = { passed: "✓ Passed", failed: "✕ Failed", running: "● Running" } as const

/* The revision's evidence as the body states it: nothing green outlives the revision it ran on. */
const BodyEvidence = ({ evidence }: { readonly evidence: Evidence }) => {
  const on = evidence.rev === undefined ? null : <> on <code>{evidence.rev}</code></>
  const failed = evidence.checks.find(check => check.state === "failed")?.name ?? evidence.github.failing
  const running = evidence.checks.some(check => check.state === "running") || evidence.github.passed < evidence.github.total
  const github = evidence.github.failing !== undefined ? "failed" : evidence.github.passed < evidence.github.total ? "running" : "passed"
  return (
    <section className="mock-gh-evidence" data-mock="gh-evidence">
      <h3>Evidence</h3>
      <p><b>{failed !== undefined ? `${failed} failed` : running ? "Checks running" : "All checks passed"}</b>{on}</p>
      <table>
        <thead><tr><th>Check</th><th>Result</th></tr></thead>
        <tbody>
          {evidence.checks.map(check => (
            <tr key={check.name} data-state={check.state}>
              <td>{check.name}</td><td>{RESULT[check.state]}{check.state === "passed" && check.took !== undefined ? ` in ${check.took}` : ""}</td>
            </tr>
          ))}
          <tr data-state={github}>
            <td>GitHub checks</td>
            <td>{evidence.github.failing !== undefined ? `✕ ${evidence.github.failing}` : `${RESULT[github]} · ${evidence.github.passed}/${evidence.github.total}`}</td>
          </tr>
        </tbody>
      </table>
      <p><b>Diff</b> +{evidence.added} −{evidence.removed} in {evidence.files} {evidence.files === 1 ? "file" : "files"}</p>
      <p><b>Review</b> {evidence.reviewing === true ? <>Running{on}</> : evidence.review}</p>
      {/* After a clean rebase the earlier review stands: same change, so it names the revision it read (§10.4.3). */}
      {evidence.reviewing !== true && evidence.previous !== undefined
        ? <p className="mock-gh-muted">Reviewed <code>{evidence.previous.rev}</code> · same change</p> : null}
    </section>
  )
}

/* The earlier stack items the PR's head includes, each as Tn with its title linked to its PR, until they merge. */
const Includes = ({ state, item }: { readonly state: State; readonly item: Todo }) => {
  const open = openItems(state.world)
  const earlier = open.slice(0, Math.max(0, open.indexOf(item)))
  if (earlier.length === 0) return null
  return (
    <p>Includes {earlier.map((each, index) => (
      <Fragment key={each.id}>{index === 0 ? "" : ", "}{refOf(state.world, each)} <a href="#">{each.title}</a>{each.pr === undefined ? "" : ` (#${each.pr})`}</Fragment>
    ))} until {earlier.length === 1 ? "it merges" : "they merge"}.</p>
  )
}

export const GitHubFrame = ({ frame, pr: number }: { readonly frame: FrameValue; readonly pr: number }) => {
  const { state } = frame
  const pr = state.world.github.find(each => each.number === number)
  if (pr === undefined) return <div className="mock-gh" data-frame="github" />
  const item = state.world.todos.find(each => each.id === pr.todo)
  const evidence = item?.evidence
  const approved = pr.approvals.length >= pr.required
  /* GitHub's own merge box reads its own checks: pending or failing ones block the button too. */
  const status = evidence?.github.failing !== undefined ? "Some checks were not successful"
    : evidence !== undefined && evidence.github.passed < evidence.github.total ? "Some checks haven't completed yet"
    : approved ? "Approved · all checks have passed" : `${pr.required} approving review required`
  return (
    <div className="mock-gh" data-frame="github">
      <div className="mock-gh-bar"><GitHubMark size={18} /><span>acme / api</span><span className="mock-gh-url">github.com/acme/api/pull/{pr.number}</span></div>
      <div className="mock-gh-body">
        <h1>{pr.title} <span>#{pr.number}</span></h1>
        <div className="mock-gh-sub">
          <span className="mock-gh-state" data-state={pr.draftAfter === undefined ? pr.state : "draft"}>
            {pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed" : pr.draftAfter === undefined ? "Open" : "Draft"}</span>
          <span><b>smithers-app</b> wants to merge into <code>{pr.base}</code> from <code>{pr.head}</code></span>
        </div>
        <article className="mock-gh-comment">
          <header><b>smithers-app</b> <span>bot</span></header>
          {item === undefined ? null : <p>{item.prompt}</p>}
          {pr.body.length === 0 ? null : <><h3>Acceptance</h3><ul>{pr.body.map(line => <li key={line}>{line}</li>)}</ul></>}
          {evidence === undefined ? null : <BodyEvidence evidence={evidence} />}
          {item === undefined ? null : <Includes state={state} item={item} />}
          <p className="mock-gh-muted">Requested by @{login(state, pr.requestedBy)}{item === undefined ? null : <> · <a href="#">{refOf(state.world, item)} in Smithers</a></>}</p>
        </article>
        {pr.commits.length === 0 ? null : (
          <ul className="mock-gh-commits">
            {pr.commits.map(commit => <li key={commit.sha}><code>{commit.sha}</code><span>{commit.text}</span><b>@{commit.by}</b></li>)}
          </ul>
        )}
        {pr.thread.map((entry, index) => (
          <article key={index} className="mock-gh-comment" data-fresh={entry.seq === state.seq || undefined} data-review={entry.line !== undefined || undefined}>
            <header><b>@{login(state, entry.who)}</b>{entry.line === undefined ? null : <span> on src/webhooks/retry.ts line {entry.line}</span>}</header>
            <p>{entry.text}</p>
          </article>
        ))}
        {pr.state === "open" ? (
          <div className="mock-gh-review">
            <textarea readOnly placeholder="Leave a comment" value={typedOr(frame, "gh-comment", "")} data-mock="gh-comment" />
          </div>
        ) : null}
        <div className="mock-gh-merge" data-state={pr.draftAfter === undefined ? pr.state : "draft"}>
          {pr.state === "merged" ? <span>Merged by @{login(state, pr.mergedBy ?? "")} into <code>{pr.base}</code></span>
            : pr.draftAfter !== undefined ? <span>Draft · merges after {pr.draftAfter}</span>
            : <>
              <span>{status}</span>
              <button type="button" disabled={status !== "Approved · all checks have passed"} data-mock="gh-merge">Merge pull request</button>
            </>}
        </div>
      </div>
    </div>
  )
}
