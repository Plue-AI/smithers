import { Fragment } from "react"
import type { SettingsViewProps } from "@smthrs/rpc/SettingsCard"
import { ModelRole, ROLE_LABELS, roleKeyAction } from "./SetupView"
import { SetupActions } from "./SetupActions"

export function SettingsModels({ model, actions, onAction }: Pick<SettingsViewProps, "model" | "actions" | "onAction">) {
  const rows = []
  for (const role of model.models) rows.push(<Fragment key={role.role}>
    <dt>{ROLE_LABELS[role.role]}</dt>
    <dd className="settings-model-row"><ModelRole role={role} chatgpt={model.chatgpt} action={roleKeyAction(actions, role.role)} onAction={onAction} omitLabel />
      <SetupActions inline actions={actions.filter(action => action.tag === "settings.model.set" && action.args?.role === role.role)} onAction={onAction} />
    </dd>
  </Fragment>)
  return <>{rows}</>
}
