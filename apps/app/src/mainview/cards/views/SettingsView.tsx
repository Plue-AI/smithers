import { copyText } from "@smthrs/ui/copy"
import type { SettingsViewProps } from "@smthrs/rpc/SettingsCard"
import { ModelAccess, ThisMac } from "./SetupFields"
import { SetupActions } from "./SetupActions"

export function SettingsView({ model, actions, onAction }: SettingsViewProps) {
  const addressStep = model.steps.find(step => step.id === "address")
  return <section className="setup-view" data-kind="settings" data-keyboard-pane="Settings" aria-label="Settings">
    <h2>Settings</h2>
    <dl className="setup-settings">
      <dt>This Mac</dt><dd><ThisMac model={model} onAction={onAction} /><span>{model.address.listen === "mac" ? "This Mac only" : "Network"} · {model.address.bind}</span>{model.address.origins.map(origin => <code key={origin}>{origin}</code>)}{addressStep?.error && <span className="setup-error" role="alert">{addressStep.error.message}</span>}{addressStep?.blocked && <a className="setup-blocked" data-tone="attention" href={addressStep.blocked.fix_url}>{addressStep.blocked.line}</a>}</dd>
      {model.address.failed && <><dt>Address</dt><dd><code>{model.address.failed.from} → {model.address.failed.to}</code><span role="alert" className="setup-error">{model.address.failed.reason.message}</span></dd></>}
      <dt>Models</dt><dd><ModelAccess model={model} /></dd>
      <dt>GitHub</dt><dd><span>{model.github.app_installed ? "App installed" : "App uninstalled"}</span>{model.repository && <code>{model.repository.owner}/{model.repository.name}</code>}</dd>
      <dt>Machines</dt><dd>{model.capacity}</dd>
      {model.parallel !== undefined && <><dt>TODOs at once</dt><dd>{model.parallel}</dd></>}
      {model.todo_daily_admissions !== undefined && <><dt>TODOs per day</dt><dd>{model.todo_daily_admissions}</dd></>}
      <dt>Laptop agent</dt><dd>{model.laptop_lines.map(line => <div className="setup-copy" key={line}><code>{line}</code><button type="button" aria-label={`Copy ${line}`} onClick={() => { void copyText(line) }}>Copy</button></div>)}</dd>
      <dt>Health</dt><dd><span>Process · {model.health.process}</span><span>PostgreSQL · {model.health.postgres_bytes} bytes</span><span>Disk free · {model.health.disk_free_gb} GB</span><span>GitHub sync · {model.health.github.health}</span><span>GitHub rate budget · {model.health.github.rate_remaining}/{model.health.github.rate_limit}</span>{model.health.github.cause && <span className="setup-error">{model.health.github.cause}</span>}{model.health.github.retry_at && <time>{model.health.github.retry_at}</time>}</dd>
      {model.notifications_need_https && <><dt>Notifications</dt><dd>Notifications need HTTPS ↗</dd></>}
      {model.obsidian && <><dt>Obsidian</dt><dd><code>{model.obsidian.path}</code>{model.obsidian.last_sync_at && <time>{model.obsidian.last_sync_at}</time>}{model.obsidian.error && <span className="setup-error" role="alert">{model.obsidian.error}</span>}</dd></>}
    </dl>
    <SetupActions actions={actions} onAction={onAction} />
  </section>
}
