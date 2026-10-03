import type { CardProps } from "@smthrs/rpc/CardAction"
import type { SetupCard } from "@smthrs/rpc/SetupCard"

import { SetupActions } from "./SetupActions"
const roles = { fast: "Fast model", coding: "Coding model", jev: "Decisions" }
export function ThisMac({ model, onAction }: { model: SetupCard; onAction: CardProps<unknown>["onAction"] }) {
  return <div className="setup-mac"><strong>This Mac</strong><span>{model.this_mac.memory_gb} GB · {model.this_mac.disk_free_gb} GB free</span>
    {model.this_mac.capacity === 0 && <div className="setup-capacity">No machine fits · {model.this_mac.limit?.term} · {model.this_mac.limit && <SetupActions actions={[model.this_mac.limit.fix]} onAction={onAction} />}</div>}
  </div>
}
export function ModelAccess({ model }: { model: SetupCard }) {
  return <div className="setup-models">{model.models.map(role => <div className="setup-model" key={role.role} data-state={role.key}>
    <span>{roles[role.role]}</span><span className="setup-muted">{role.provider}</span>
    <input type="password" aria-label={role.role === "jev" ? "AI Gateway key" : `${roles[role.role]} key`} readOnly value={role.key === "saved" || role.key === "validating" ? "••••••••••••" : ""} aria-invalid={role.key === "failed" || undefined} />
    <span className="setup-key-state" data-tone={role.key === "validating" ? "live" : role.key === "failed" ? "failed" : "quiet"}>{role.key === "none" ? "" : role.key === "saved" ? "Saved" : role.key === "validating" ? "Validating" : "Failed"}</span>
    {role.error && <span className="setup-error" role="alert">{role.error}</span>}
  </div>)}</div>
}
