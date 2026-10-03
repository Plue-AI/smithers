import { useState } from "react"
import type { Action } from "@smthrs/rpc/CardAction"
import type { Actor, EvidenceItem } from "@smthrs/rpc/CardPrimitives"
import type { TodoViewProps } from "@smthrs/rpc/TodoCard"

export const todoActorName = (actor: Actor): string => {
  if (actor.kind === "person") return actor.name + (actor.via ? ` via ${actor.via.toUpperCase()}` : "")
  if (actor.kind === "github") return actor.login
  if (actor.kind === "system") return "Install"
  if (actor.kind === "outside") return "Changed outside Smithers"
  const name = actor.name ?? ({ smithers: "Smithers", coding: "Coding agent", reviewer: "Reviewer", "claude-code": "Claude Code", codex: "Codex", external: "Agent" }[actor.agent])
  return name + (actor.for_member ? ` for ${actor.for_member.name}` : "")
}
// Local primitive until T-UI-01 lands.
export const TodoActor = ({ actor }: { actor: Actor }) => <span className="todo-actor" title={todoActorName(actor)} style={{ color: `var(${actor.color_index < 6 ? `--lane-${actor.color_index}` : actor.color_index === 6 ? "--brand" : "--text-muted"})` }}>
  {"avatar_url" in actor ? <img src={actor.avatar_url} alt="" data-kind={actor.kind} /> : <span aria-hidden="true">▪</span>}{todoActorName(actor)}
</span>
const states = { queued: "Queued", starting: "Starting", working: "Working", needs_you: "Needs you", paused: "Paused", failed: "Failed", in_review: "In review", merged: "Merged", dropped: "Dropped" }
function ActionControl({ action, onAction }: { action: Action; onAction: TodoViewProps["onAction"] }) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  if (action.disabled) return <span className="todo-disabled">{action.disabled.reason}</span>
  const fields = action.input ?? []
  if (!fields.length) return <button type="button" data-flow={action.tag} data-primary={action.primary} onClick={() => onAction(action.tag, { ...action.args })}>{action.label}</button>
  return <form className="todo-form" data-flow={action.tag} onSubmit={event => { event.preventDefault(); onAction(action.tag, { ...action.args, ...Object.fromEntries(fields.map(field => [field.name, draft[field.name] ?? field.value ?? ""])) }) }}>
    {fields.map(field => <label key={field.name}><span className="todo-sr">{field.label}</span>{field.kind === "choice" ? <select aria-label={field.label} required={field.required} value={draft[field.name] ?? field.value ?? ""} onChange={event => setDraft({ ...draft, [field.name]: event.target.value })}><option value="" />{field.choices?.map(choice => <option key={choice}>{choice}</option>)}</select> : field.multiline ? <textarea aria-label={field.label} placeholder={field.label} required={field.required} value={draft[field.name] ?? field.value ?? ""} onChange={event => setDraft({ ...draft, [field.name]: event.target.value })} /> : <input aria-label={field.label} placeholder={field.label} type={field.kind === "secret" ? "password" : "text"} required={field.required} value={draft[field.name] ?? field.value ?? ""} onChange={event => setDraft({ ...draft, [field.name]: event.target.value })} />}</label>)}
    <button type="submit" data-flow={action.tag} data-primary={action.primary}>{action.label}</button>
  </form>
}
function EvidenceLine({ item }: { item: EvidenceItem }) {
  switch (item.kind) {
    case "diff": return <span><b className="todo-add">+{item.added}</b> <b className="todo-failed">−{item.removed}</b> · {item.files} files</span>
    case "check": return <span data-check={item.state}>{item.log_url ? <a href={item.log_url}>{item.name}</a> : item.name} · {item.state}{item.took_s === undefined ? "" : ` · ${item.took_s}s`}</span>
    case "github_check": return <span data-check={item.state}><a href={item.url}>{item.name}</a> · {item.required ? "Required" : "Optional"} · {item.state}</span>
    case "review": return <span>{item.summary}</span>
    case "usage": return <span>{item.tokens.toLocaleString("en-US")} tokens · {item.time_s}s</span>
    case "flow": return <span>{item.name} · {item.version}</span>
    case "model_access": return <span>{item.label}</span>
  }
}
export function TodoView({ model: todo, actions, onAction }: TodoViewProps) {
  const tone = todo.state === "failed" ? "failed" : todo.state === "needs_you" ? "attention" : ["starting", "working"].includes(todo.state) ? "live" : "quiet"
  const mergeAction = actions.find(action => action.tag === "merge")
  const mergeReason = mergeAction?.disabled?.reason ?? todo.merge.detail ?? ({ state: "Waiting for review", order: "Waiting for stack order", attention: "Needs you", merging: "Merging", rechecking: "Checks running", pending_work: "Work pending", stale_head: "Head changed", checks: "Checks failed", review_required: "Review required", github: "Waiting on GitHub" }[todo.merge.reason ?? "state"])
  return <article className="todo-view" data-keyboard-pane="TODO" aria-label={`TODO T${todo.n}`}>
    <header><h2><span className="todo-ref">T{todo.n}</span> {todo.title}</h2><span className="todo-state" data-tone={tone}>{states[todo.state]}</span><img className="todo-owner" src={todo.owner.avatar_url} alt={todo.owner.name} /></header>
    <div className="todo-meta"><span>{todo.branch.name}</span><span>{todo.owner.name}{todo.owner_removed ? " · Removed" : ""}</span>{todo.place && <span>{todo.place === 1 ? "Next to merge" : `#${todo.place} in stack`}</span>}{todo.run && <span>Attempt {todo.run.attempt}</span>}{todo.issue && <a href={todo.issue.url}>{todo.state === "merged" && todo.issue.fixes ? "Closed" : "From"} #{todo.issue.number}</a>}</div>
    {todo.queue && <p className="todo-meta">{({ machine: "Waiting for a machine", merge_order: `Waiting for T${todo.queue.after}`, rebase: "Waiting for a rebase", daily_limit: "Daily limit" })[todo.queue.reason]} · #{todo.queue.position}</p>}
    {todo.pause && <p className="todo-meta">Paused · {todo.pause.reason === "person" ? "Stopped" : "Daily token budget"}{todo.pause.owner && ` · ${todo.pause.owner.name}`}{todo.pause.resume_at && ` · ${todo.pause.resume_at}`}</p>}
    {todo.rebase_pending && <p className="todo-meta">Rebase pending onto {todo.rebase_pending.onto} ↶ Verify</p>}
    {todo.prompt_revisions[0] && <p className="todo-prompt">{todo.prompt_revisions[0].text}</p>}
    {todo.prompt_revisions.length > 1 && <details><summary>+{todo.prompt_revisions.length - 1}</summary>{todo.prompt_revisions.slice(1).map((revision, index) => <div className="todo-authored" key={index}><TodoActor actor={revision.by} /><span>{revision.text}</span><ul>{revision.acceptance.map(text => <li key={text}>{text}</li>)}</ul></div>)}</details>}
    <ol className="todo-steps" aria-label="Flow steps">{todo.steps.map(step => <li key={step.id} data-phase={step.state} data-wait={"kind" in step ? true : undefined}><span className="todo-step-mark" aria-hidden="true">{step.state === "done" ? "✓" : ""}</span><span>{"label" in step ? step.label : "Wait for merge"}</span>{"detail" in step && step.detail && <small>{step.detail}</small>}</li>)}</ol>
    {todo.run?.indicators.map((flag, index) => <p className="todo-meta" key={index}>{flag.text}</p>)}
    {todo.waits.map(wait => <section className="todo-wait" key={wait.id} data-wait-id={wait.id}><div className="todo-authored">{wait.by && <TodoActor actor={wait.by} />}<b>{wait.prompt}</b></div>{wait.paths?.map(path => <code key={path}>{path}</code>)}{wait.ssh_line && <code>{wait.ssh_line}</code>}{wait.sha && <code>{wait.sha}</code>}<div className="todo-actions">{wait.actions.map((action, index) => <ActionControl key={`${action.tag}-${index}`} action={action} onAction={onAction} />)}</div></section>)}
    {todo.first_answer && <div className="todo-authored"><b>{todoActorName(todo.first_answer.by)} answered</b><span>{todo.first_answer.text}</span></div>}
    {todo.steers.map((steer, index) => <div className="todo-authored" key={index}><TodoActor actor={steer.by} /><span>{steer.text}</span></div>)}
    {todo.failure && <div className="todo-failure"><b>{todo.failure.step} failed</b><span>{todo.failure.message}</span>{todo.failure.missing_tool && <code>{todo.failure.missing_tool.name} · {todo.failure.missing_tool.file}</code>}</div>}
    {todo.pr && <div className="todo-evidence-row"><span>PR</span><div><a href={todo.pr.url}>#{todo.pr.number} on GitHub</a> · <code>{todo.pr.head}</code>{todo.pr.draft && <span> · Draft</span>}{todo.pr.draft_after && <span> · merges after T{todo.pr.draft_after}</span>}{todo.pr.included_items.filter(n => n !== todo.n).map(n => <span key={n}> · Includes T{n}</span>)}</div></div>}
    {todo.evidence.map(evidence => <section className="todo-evidence" key={`${evidence.attempt}-${evidence.revision}`} aria-label={`Attempt ${evidence.attempt} evidence`}><div className="todo-meta">Attempt {evidence.attempt} · <code>{evidence.revision}</code></div>{evidence.items.map((item, index) => <div className="todo-evidence-row" key={index}><span>{({ diff: "Diff", check: "Checks", github_check: "GitHub", review: "Review", usage: "Usage", flow: "Flow", model_access: "Model" })[item.kind]}</span><EvidenceLine item={item} /></div>)}{evidence.reviewing && <p className="todo-live">Running on {evidence.revision}</p>}{evidence.previous && <><p>Reviewed {evidence.previous.revision}{evidence.reviewing ? "" : " · same change"}</p>{evidence.previous.items.filter(item => item.kind === "review").map((item, index) => <EvidenceLine key={index} item={item} />)}</>}</section>)}
    {todo.approval_cleared && <p className="todo-attention">Approval cleared by rebase · checks rerun</p>}
    {todo.merged_via && <p>Merged · in T{todo.merged_via}'s commit</p>}
    <div className="todo-actions">{actions.map((action, index) => action.tag === "merge" && (todo.merge.state !== "ready" || action.disabled) ? null : <ActionControl key={`${action.tag}-${index}`} action={action} onAction={onAction} />)}</div>
    {todo.merge.state !== "done" && (!mergeAction || todo.merge.state !== "ready" || mergeAction.disabled) && <div className="todo-merge-reason" data-tone={todo.merge.reason === "checks" && todo.merge.state === "blocked" ? "failed" : ["review_required", "attention"].includes(todo.merge.reason ?? "") ? "attention" : "quiet"}>{todo.merge.state === "ready" ? "Ready · a maintainer merges" : todo.merge.state === "merging" ? "Merging" : mergeReason}{todo.merge.on_github && todo.pr && <> · <a href={todo.pr.url}>on GitHub</a></>}</div>}
    {todo.present.length > 0 && <div className="todo-presence">{todo.present.map((actor, index) => <TodoActor actor={actor} key={index} />)}</div>}
  </article>
}
