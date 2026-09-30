import { flowArgs } from "../../flows/FlowArgs"
import type { GatewayBinding } from "../RepoContext"
import type { ControllerContext } from "./context"
import { formRenderedText, type FormsController } from "./forms"

/**
 * THE FORM LAW for a box-bound act (#2327): a human picks among several boxes,
 * or opens one explicitly when none exists. A box.select Submit resumes the
 * pending act once; box.open only opens a box, so its title tells the human to
 * retry the original act. Agents keep the refusal sentence.
 */
export const refuseOrPickBox = (
  ctx: Pick<ControllerContext, "commandActor">,
  renderFlowForm: FormsController["renderFlowForm"] | undefined,
  refusal: Extract<GatewayBinding, { readonly error: string }>,
  act: { readonly repo: string; readonly flow: string; readonly args?: string },
  openTitle?: string
): string | { readonly value: string } => {
  if (ctx.commandActor !== "user" || renderFlowForm === undefined) return refusal.error
  if (refusal.choices !== undefined) {
    const rendered = renderFlowForm({ name: "box.select", args: flowArgs("box.select", act), via: "user" })
    return rendered === undefined ? refusal.error : { value: formRenderedText(rendered.missing) }
  }
  if (refusal.noBox === true && openTitle !== undefined) {
    const rendered = renderFlowForm({ name: "box.open", args: flowArgs("box.open", { repo: act.repo }), via: "user",
      cardId: `form-box.open-${act.flow}`, title: openTitle })
    return rendered === undefined ? refusal.error : { value: `${openTitle}.` }
  }
  return refusal.error
}
