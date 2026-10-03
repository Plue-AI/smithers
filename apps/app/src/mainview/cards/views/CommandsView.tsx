import type { CommandsViewProps } from "@smthrs/rpc/CommandsCard"
import { CommandActionView } from "./CommandActionView"

function CommandRows({ commands }: { commands: CommandsViewProps["model"]["groups"][number]["commands"] }) {
  return <dl>{commands.map((command, index) => <div key={index} className="mvp-command">
    <dt>{command.synopsis === "⌘K (no slash)" ? <><kbd>⌘K</kbd> (no slash)</> : <code>{command.synopsis}</code>}</dt>
    <dd>{command.description}</dd>
    {command.agent !== "run" && <dd className="mvp-command-policy">{command.agent === "confirm" ? "Asks first" : "Only you"}</dd>}
  </div>)}</dl>
}

export function CommandsView({ model, actions, onAction }: CommandsViewProps) {
  const controls = []
  for (const [index, action] of actions.entries()) controls.push(<CommandActionView key={`${index}:${JSON.stringify(action)}`} action={action} onAction={onAction} />)
  return <article className="mvp-commands-card" aria-label="Commands">
    <div className="mvp-commands">{model.groups.map((group, index) => group.advanced
      ? <details key={index} className="mvp-commands-advanced"><summary>{group.label}</summary><CommandRows commands={group.commands} /></details>
      : <section key={index}><h3>{group.label}</h3><CommandRows commands={group.commands} /></section>)}</div>
    {controls}
  </article>
}
