import { copyText } from "@smthrs/ui/copy"
import type { SettingsViewProps } from "@smthrs/rpc/SettingsCard"
import { ThisMac } from "./SetupFields"
import { formatBytes } from "./formatBytes"
import { SettingsModels } from "./SettingsModels"
import type { Action } from "@smthrs/rpc/CardAction"
import { SetupActions } from "./SetupActions"

export function SettingsView({ model, actions, onAction, view, onView }: SettingsViewProps) {
  const repositoryBlocker = model.steps.find(step => step.id === "repository")?.blocked
  const addressStep = model.steps.find(step => step.id === "address")
  const addressActions = actions.filter(action => action.args?.step === "address")
  const rowFor = (action: Action) => action.tag === "settings.model.set" || (action.tag === "settings.model-key" && action.args?.role) ? `model:${action.args?.role}`
    : action.tag === "github" ? "health"
    : action.tag === "docs" && action.args?.page === "quickstart#put-https-in-front" ? "notifications"
    : action.tag === "settings" ? action.args?.step === "address" ? "address" : action.args?.field
    : action.tag === "settings.address" || action.tag === "settings.capacity" || action.tag === "settings.parallel" || action.tag === "settings.obsidian" ? action.args?.field : undefined
  const rowActions = (row: string, value?: number | string) => actions.filter(action => rowFor(action) === row).map(action => ({
    ...action, label: row === "obsidian" ? "Change" : action.label,
    input: action.input?.map(field => value === undefined ? field : { ...field, value: String(value) })
  }))
  const hasRow = (action: Action) => ["address", "health", "capacity", "obsidian", ...model.models.map(role => `model:${role.role}`),
    ...(model.parallel !== undefined ? ["parallel"] : []), ...(model.todo_daily_admissions !== undefined ? ["todo_daily_admissions"] : []),
    ...(model.notifications_need_https ? ["notifications"] : [])].includes(rowFor(action) ?? "")
  /* mvp.md J1 2.1 / §6.15: This Mac only, or Network with the bind and the addresses teammates use. The choice is member view state. */
  const reach = actions.filter(action => action.tag === "settings.address" && (action.args?.listen === "mac" || action.args?.listen === "network"))
  const choice = view.tab === "mac" || view.tab === "network" ? view.tab : model.address.listen
  const reachForm = reach.filter(action => action.args?.listen === choice && !(choice === "mac" && model.address.listen === "mac"))
  return <section className="setup-view" data-kind="settings" data-keyboard-pane="Settings" aria-label="Settings">
    <h2>Settings</h2>
    <dl className="setup-settings">
      <dt>This Mac</dt><dd><ThisMac model={model} onAction={onAction} />{reach.length === 0 ? <span>{model.address.listen === "mac" ? "This Mac only" : "Network"} · {model.address.bind}</span>
        : <span className="setup-segmented" role="group" aria-label="Who can reach it">{(["mac", "network"] as const).map(listen => <button key={listen} type="button" aria-pressed={choice === listen} onClick={() => onView({ tab: listen })}>{listen === "mac" ? "This Mac only" : "Network"}</button>)}</span>}{model.address.origins.map(origin => <span key={origin}><code>{origin}</code>{new URL(origin).protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname) && <span> · unencrypted</span>}</span>)}{addressStep?.error && <span className="setup-error" role="alert">{addressStep.error.message}</span>}{addressStep?.blocked && <a className="setup-blocked" data-tone="attention" href={addressStep.blocked.fix_url}>{addressStep.blocked.line}</a>}{model.address.failed && <div className="setup-address-failed"><span role="alert" className="setup-error">{model.address.failed.reason.message}</span><SetupActions actions={addressActions} onAction={onAction} /><span>In effect: <code>{model.address.failed.from}</code></span></div>}{!model.address.failed && <SetupActions inline actions={rowActions("address").filter(action => !reach.some(each => each.tag === action.tag && each.args?.listen === action.args?.listen))} onAction={onAction} />}{!model.address.failed && <SetupActions actions={reachForm} onAction={onAction} />}</dd>
      <SettingsModels model={model} actions={actions} onAction={onAction} />
      <dt>GitHub</dt><dd><span>{model.github.app_installed ? "App installed" : "App uninstalled"}</span>{model.repository && <code>{model.repository.owner}/{model.repository.name}</code>}{repositoryBlocker && <a href={repositoryBlocker.fix_url} target="_blank" rel="noreferrer">{repositoryBlocker.line}</a>}</dd>
      <dt>Machines</dt><dd>{rowActions("capacity", model.capacity).length ? <SetupActions inline actions={rowActions("capacity", model.capacity)} onAction={onAction} /> : model.capacity}</dd>
      {model.parallel !== undefined && <><dt>TODOs at once</dt><dd>{rowActions("parallel", model.parallel).length ? <SetupActions inline actions={rowActions("parallel", model.parallel)} onAction={onAction} /> : model.parallel}</dd></>}
      {model.todo_daily_admissions !== undefined && <><dt>TODOs per day</dt><dd>{rowActions("todo_daily_admissions", model.todo_daily_admissions).length ? <SetupActions inline actions={rowActions("todo_daily_admissions", model.todo_daily_admissions)} onAction={onAction} /> : model.todo_daily_admissions}</dd></>}
      <dt>Laptop agent</dt><dd>{model.laptop_lines.map(line => <div className="setup-copy" key={line}><code>{line}</code><button type="button" aria-label={`Copy ${line}`} onClick={() => { void copyText(line) }}>Copy</button></div>)}</dd>
      <dt>Health</dt><dd><span>Process · {model.health.process}</span><span>PostgreSQL · {formatBytes(model.health.postgres_bytes)}</span><span>Disk free · {model.health.disk_free_gb} GB</span><span>GitHub sync · {model.health.github.health}</span><span>GitHub rate budget · {model.health.github.rate_remaining}/{model.health.github.rate_limit}</span>{model.health.github.cause && <span className="setup-error">{model.health.github.cause}</span>}{model.health.github.retry_at && <time>{model.health.github.retry_at}</time>}<SetupActions inline actions={rowActions("health")} onAction={onAction} /></dd>
      {model.notifications_need_https && <><dt>Notifications</dt><dd>{rowActions("notifications").length ? <SetupActions inline actions={rowActions("notifications")} onAction={onAction} /> : "Notifications need HTTPS ↗"}</dd></>}
      {(model.obsidian || actions.some(action => rowFor(action) === "obsidian")) && <><dt>Obsidian folder</dt><dd>{model.obsidian && !rowActions("obsidian").length && <code>{model.obsidian.path}</code>}<SetupActions inline actions={rowActions("obsidian", model.obsidian?.path)} onAction={onAction} />{model.obsidian?.last_sync_at && <time>{model.obsidian.last_sync_at}</time>}{model.obsidian?.error && <span className="setup-error" role="alert">{model.obsidian.error}</span>}</dd></>}
    </dl>
    <SetupActions actions={actions.filter(action => !hasRow(action))} onAction={onAction} />
  </section>
}
