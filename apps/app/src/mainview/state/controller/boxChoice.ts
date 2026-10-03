import { flowArgs } from "../../flows/FlowArgs"
import type { GatewayBinding } from "../RepoContext"
import type { ControllerContext } from "./context"
import {  type FormsController } from "./forms"

/** A box-bound act may open a box when none exists; ambiguous branches retain the refusal. */
export const refuseOrPickBox = (
  ctx: Pick<ControllerContext, "commandActor">,
  renderFlowForm: FormsController["renderFlowForm"] | undefined,
  refusal: Extract<GatewayBinding, { readonly error: string }>,
  act: { readonly repo: string; readonly flow: string; readonly args?: string },
  openTitle?: string
): string | { readonly value: string } => {
  if (ctx.commandActor !== "user" || renderFlowForm === undefined) return refusal.error
  if (refusal.noBox === true && openTitle !== undefined) {
    const rendered = renderFlowForm({ name: "box.open", args: flowArgs("box.open", { repo: act.repo }), via: "user",
      cardId: `form-box.open-${act.flow}`, title: openTitle })
    return rendered === undefined ? refusal.error : { value: `${openTitle}.` }
  }
  return refusal.error
}
