import { Fragment } from "react"
import type { SettingsViewProps } from "@smthrs/rpc/SettingsCard"
import { ModelAccess } from "./SetupFields"
import { SetupActions } from "./SetupActions"

export function SettingsModels({ model, actions, onAction }: Pick<SettingsViewProps, "model" | "actions" | "onAction">) {
  const rows = []
  for (const role of model.models) rows.push(<Fragment key={role.role}>
    <dt>{{ fast: "Fast model", coding: "Coding model", jev: "Decisions" }[role.role]}</dt>
    <dd className="settings-model-row"><ModelAccess model={{ ...model, models: [role] }} omitLabel />
      <SetupActions inline actions={actions.filter(action => action.tag === "settings.model.set" && action.args?.role === role.role)} onAction={onAction} />
    </dd>
  </Fragment>)
  return <>{rows}</>
}
