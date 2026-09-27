import { flowArgs } from "../../flows/FlowArgs"
import type { GatewayBinding } from "../RepoContext"
import type { ControllerContext } from "./context"
import { formRenderedText, type FormsController } from "./forms"

/**
 * THE FORM LAW for a box-bound act (#2327): when several boxes could be meant,
 * a human's act renders the box.select form for exactly those boxes instead
 * of the "Select a box" sentence. The act rides the form's payload, so Submit
 * selects the chosen box and runs the act once (TabsController.selectBox).
 * The agent keeps the sentence: which box an act runs on is the human's pick.
 */
export const refuseOrPickBox = (
  ctx: Pick<ControllerContext, "commandActor">,
  renderFlowForm: FormsController["renderFlowForm"] | undefined,
  refusal: Extract<GatewayBinding, { readonly error: string }>,
  act: { readonly repo: string; readonly flow: string; readonly args?: string }
): string | { readonly value: string } => {
  if (refusal.choices === undefined || ctx.commandActor !== "user" || renderFlowForm === undefined) return refusal.error
  const rendered = renderFlowForm({ name: "box.select", args: flowArgs("box.select", act), via: "user" })
  return rendered === undefined ? refusal.error : { value: formRenderedText(rendered.missing) }
}
