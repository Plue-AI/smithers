/*
 * Review material, not product UI: what the MVP defers (mvp.md §15 and §16,
 * and the TUI from §8), one line each with where the spec defers it and the
 * issue that tracks it, for Will to ratify. No release is promised for any of
 * it. It is drawn as harness so nobody mistakes it for a card in the app. New
 * items go at the end, so the numbers reviewers cite stay put.
 */
import type { ExtraCardProps } from "./extra"

const DEFERRED: ReadonlyArray<{ readonly item: string; readonly area: string; readonly issue?: number }> = [
  { item: "The terminal app (TUI)", area: "§8", issue: 3468 },
  { item: "Smithers Cloud, billing and plans", area: "M-09", issue: 3467 },
  { item: "Line comments on diffs in the app", area: "§6.10" },
  { item: "Agent replies on GitHub reviews", area: "§6.3" },
  { item: "Stacked PR bases and retargeting", area: "§4.2" },
  { item: "Open a teammate's own branch on a machine", area: "§6.3" },
  { item: "Bring a laptop push in automatically", area: "§6.3" },
  { item: "Ask to type in someone else's terminal", area: "§6.8" },
  { item: "Command name on outside-change entries, per-entry Undo, replaced-edit flags", area: "§6.8" },
  { item: "Exact attribution of terminal changes with several sessions active", area: "§6.8" },
  { item: "Email and phone notifications", area: "§6.4", issue: 3423 },
  { item: "Triggers that start flows", area: "§6.14", issue: 3469 },
  { item: "The Machine view", area: "§6.14", issue: 3469 },
  { item: "Sending signals to runs by hand", area: "§6.14", issue: 3469 },
  { item: "A form for agent permissions, tools and budget", area: "§6.14", issue: 3469 },
  { item: "Obsidian on teammates' laptops", area: "§6.11" },
  { item: "Replace a stack item's work with a scratch branch", area: "J7" },
  { item: "Which runs used each secret", area: "§6.15" },
  { item: "Mobile web", area: "§15", issue: 3426 },
  { item: "File history and blame", area: "§15", issue: 3424 },
  { item: "Deploy previews (SSH port forwarding covers it for now)", area: "§15", issue: 3425 },
  { item: "Agent-pinnable rail icons", area: "§6.4", issue: 3334 }
]

export const LaterCard = ({ id }: ExtraCardProps) => (
  <section className="mock-later" data-card={id} data-mock="card-later" aria-label="Deferred from MVP">
    <header>
      <h2>Deferred from MVP</h2>
      <span>For ratification</span>
    </header>
    <ol>
      {DEFERRED.map(({ item, area, issue }) => (
        <li key={item}>
          <span>{item}</span>
          {issue === undefined ? <span /> : <a className="mock-later-issue" href={`https://github.com/smithersai/smithers/issues/${issue}`}>#{issue}</a>}
          <span className="mock-later-area">{area}</span>
        </li>
      ))}
    </ol>
  </section>
)
