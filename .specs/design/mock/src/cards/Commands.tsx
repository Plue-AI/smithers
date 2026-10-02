/*
 * /help (mvp.md Appendix A): every MVP command, grouped. Each one has three
 * doors: a plain ⌘K request, the slash command, and a button on its card.
 * Advanced primitives arrive later in a collapsed group (§6.14).
 */
import { Card, Kbd } from "../parts"
import type { ExtraCardProps } from "./extra"

export const CATALOG: ReadonlyArray<{ group: string; commands: ReadonlyArray<[string, string]> }> = [
  { group: "Ask", commands: [["⌘K", "Ask or tell Smithers anything"], ["/help", "List these commands"], ["/stop", "Stop the current answer"], ["/search", "Search code, wiki and runs"]] },
  { group: "TODOs and the stack", commands: [
    ["/stack", "Show the stack and background runs"], ["/todo.new", "Write and place a TODO"], ["/todo.from-issue #n", "Draft a TODO from an issue"],
    ["/todo Tn", "Open a TODO's card"], ["/todo.answer Tn", "Answer the agent's question"], ["/todo.steer Tn", "Send the agent a correction"],
    ["/todo.amend Tn", "Change an unmerged TODO's prompt"], ["/todo.stop Tn", "Pause a working TODO"], ["/todo.resume Tn", "Resume a paused TODO"],
    ["/todo.retry Tn", "Retry a failed TODO"], ["/todo.drop Tn", "Abandon an unmerged TODO"], ["/stack.move Tn up|down", "Reorder an item"], ["/merge Tn", "Review and merge the next item"]] },
  { group: "Branches and machines", commands: [
    ["/branches", "List branches with presence"], ["/branch <name|#n>", "Open a branch's card"], ["/branch.fork", "Fork a scratch branch"],
    ["/branch.add-to-stack", "Add a scratch branch as a TODO"], ["/branch.rebase", "Rebase this branch now"], ["/terminal", "Open a terminal on a branch"],
    ["/ssh", "Copy the SSH line for a branch"]] },
  { group: "Files and code", commands: [["/file <path>", "Open and co-edit a file"], ["/files", "Browse a branch's files"], ["/diff", "Show a branch's changes"]] },
  { group: "Review", commands: [["/review", "Review a change, return findings"], ["/pr #n", "Open a pull request's card"]] },
  { group: "Issues", commands: [["/issues", "List the repository's issues"], ["/issue #n", "Open an issue's card"], ["/issue.new", "Open a GitHub issue"], ["/issue.comment #n", "Comment on an issue"]] },
  { group: "Wiki", commands: [["/wiki", "Open the wiki"], ["/wiki.page <name>", "Open or create a page"], ["/wiki.save", "Save this answer as a page"]] },
  { group: "Flows", commands: [["/flows", "List the repository's flows"], ["/flow <name>", "Show a flow's steps and versions"], ["/flow.edit <name>", "Propose a change to a flow"], ["/flow.run <name>", "Run a flow with typed input"], ["/flow.new", "Create a new flow"]] },
  { group: "Runs", commands: [["/runs", "Active and attention-needing runs"], ["/run <id>", "Open a run's card"]] },
  { group: "GitHub", commands: [["/github", "Sync state and links to GitHub"]] },
  { group: "Account and settings", commands: [["/settings", "Model access, machines, GitHub"], ["/members", "Add people and set roles"], ["/secrets", "Set secrets machines can use"], ["/sign-in", "Sign in with GitHub"], ["/sign-out", "Sign out"], ["/theme", "Switch light or dark"]] }
]

/* One click away, never on the first screen (mvp.md §6.14). */
const ADVANCED: ReadonlyArray<[string, string]> = [
  ["/run.inspect <id>", "Inspect a run's timeline"], ["/monitor", "Every live run, inspectable"], ["/flow.source <name>", "Open a flow's source"],
  ["/flow.plan <name>", "Preview a flow's plan"], ["/agents", "List the coding agents"], ["/agent <name>", "An agent's model and instructions"]
]

export const CommandsCard = ({ id }: ExtraCardProps) => (
  <Card id={id} kind="commands" title="Commands">
    <div className="mvp-commands">
      {CATALOG.map(({ group, commands }) => (
        <section key={group}>
          <h3>{group}</h3>
          <dl>
            {commands.map(([slash, what]) => (
              <div key={slash} className="mvp-command">
                <dt>{slash === "⌘K" ? <Kbd>⌘K</Kbd> : <code>{slash}</code>}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <details className="mvp-commands-advanced">
        <summary>Advanced</summary>
        <dl>{ADVANCED.map(([slash, what]) => <div key={slash} className="mvp-command"><dt><code>{slash}</code></dt><dd>{what}</dd></div>)}</dl>
      </details>
    </div>
  </Card>
)
