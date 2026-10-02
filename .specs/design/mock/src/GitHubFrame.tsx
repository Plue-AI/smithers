/*
 * The GitHub side of J10, outside the product: a pull request as GitHub shows
 * it, rendered from the same world, so every sync is visible from both ends.
 * Neutral styling on purpose: it stands for GitHub, it doesn't copy it.
 */
import { member, type ActorId, type State } from "./world"
import { typedOr, type FrameValue } from "./frame"
import { GitHubMark } from "./parts"

const login = (state: State, who: ActorId | string): string => member(state.world, who)?.login ?? who

export const GitHubFrame = ({ frame, pr: number }: { readonly frame: FrameValue; readonly pr: number }) => {
  const { state } = frame
  const pr = state.world.github.find(each => each.number === number)
  if (pr === undefined) return <div className="mock-gh" data-frame="github" />
  const approved = pr.approvals.length >= pr.required
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
          <header><b>smithers-app</b> <span>bot · Requested by @{login(state, pr.requestedBy)}</span></header>
          {pr.body.map((line, index) => <p key={index}>{line}</p>)}
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
              <span>{approved ? "Approved · all checks have passed" : `${pr.required} approving review required`}</span>
              <button type="button" disabled={!approved} data-mock="gh-merge">Merge pull request</button>
            </>}
        </div>
      </div>
    </div>
  )
}
