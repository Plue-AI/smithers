import { Fragment } from "react"
import type { SettingsViewProps } from "@smthrs/rpc/SettingsCard"
import { ModelRole, ROLE_LABELS, roleKeyAction } from "./views/SetupView"
import { SetupActions } from "./views/SetupActions"

export function ModelRoles({ model, actions, onAction }: Pick<SettingsViewProps, "model" | "actions" | "onAction">) {
  const rows = []
  for (const role of model.models) rows.push(<Fragment key={role.role}>
    <dt>{ROLE_LABELS[role.role]}</dt>
    <dd className="settings-model-row"><ModelRole role={role} chatgpt={model.chatgpt} action={roleKeyAction(actions, role.role)} onAction={onAction} omitLabel />
      {(role.key === "saved" || role.key === "failed") && roleKeyAction(actions, role.role) && <button type="button" data-testid={`settings-key-remove-${role.role}`} data-flow="settings.model-key" onClick={() => onAction("settings.model-key", { ...roleKeyAction(actions, role.role)?.args, role: role.role, provider: role.provider, action: "remove" })}>Remove</button>}
      {role.model && <span data-testid={`settings-model-${role.role}`}>{role.model}</span>}
      <SetupActions inline actions={actions.filter(action => action.tag === "settings.model.set" && action.args?.role === role.role)} onAction={onAction} />
    </dd>
  </Fragment>)
  return <>{rows}</>
}

import type { Card } from "../state/AppState"
import type { RunCommand } from "./CardFamily"
import { flowAction } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import { Button } from "@smthrs/ui"
type AgentRow = Extract<Extract<Card, { kind: "agents" }>["payload"], { native: boolean }>["agents"][number]

export function AgentModel({ agent, canAssign, onRunCommand }: { readonly agent: AgentRow; readonly canAssign: boolean; readonly onRunCommand: RunCommand }) {
 return <>
  {agent.source && <span data-testid={`agent-source-${agent.id}`}>{agent.source}</span>}
  {agent.instructions && <Button variant="ghost" size="sm" {...flowAction(onRunCommand, "files.read", flowArgs("files.read", { path: agent.instructions, ref: "main" }))}>{agent.instructions}</Button>}
  {canAssign && agent.binding && <Button variant="ghost" size="sm" data-testid={`agent-model-${agent.id}`} {...flowAction(onRunCommand, "model.assign", flowArgs("model.assign", { role: agent.id }))}>Change model</Button>}
 </>
}

import type { ConfiguredModel } from "@smthrs/rpc/ConfiguredModel"
export function ModelRecords({ models, testing = [], onRunCommand }: { readonly models: ReadonlyArray<ConfiguredModel & { readonly lastTest?: import("@smthrs/rpc/ConfiguredModel").ModelTestRecord }>; readonly testing?: ReadonlyArray<string>; readonly onRunCommand: RunCommand }) {
 return <div className="models-card"><ul className="workflow-list">{models.map(model => <li key={model.id} className="workflow-list-row" data-model-id={model.id}>
  <strong>{model.id}</strong><span>{model.modelId}</span>
  {model.lastTest && <span role={model.lastTest.result.ok ? undefined : "alert"}>{model.lastTest.result.ok ? `${model.lastTest.result.latencyMs} ms` : "Failed"}</span>}
  <Button size="sm" variant="ghost" disabled={testing.includes(model.id)} {...flowAction(onRunCommand, "model.test", model.id)}>Test</Button>
  {!model.builtin && <><Button size="sm" variant="ghost" {...flowAction(onRunCommand, "model.edit", model.id)}>Edit</Button><Button size="sm" variant="ghost" {...flowAction(onRunCommand, "model.remove", model.id)}>Remove</Button></>}
 </li>)}</ul><Button size="sm" {...flowAction(onRunCommand, "model.new")}>New</Button></div>
}
