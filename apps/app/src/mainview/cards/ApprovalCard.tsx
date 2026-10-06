import { Data } from "effect"
import type { ConfirmCard, ConfirmViewProps } from "@smthrs/rpc/ConfirmCard"
import { cardActions } from "../flows/cardActions"
import type { CardFamily } from "./CardFamily"

export class ConfirmationUnavailable extends Data.TaggedError("ConfirmationUnavailable") {
  readonly message = "Confirmation unavailable"
  readonly status = 503
  readonly error = { class: "infra", code: "confirmation_unavailable", message: "Confirmation unavailable" }
}

/** T-ACC-02/03/04 and T-CAT-01 must supply private audience and session-only dispatch before activation. */
export const confirmationUnavailable = (): never => {
  throw new ConfirmationUnavailable()
}

/** No initiating command is dispatched as an approval; missing consumers fail before effects. */
export const confirmCardProps = (model: ConfirmCard): ConfirmViewProps => ({
  model,
  ...cardActions(confirmationUnavailable, [], confirmationUnavailable),
  view: { maximized: false },
  onView: () => {}
})

/** Legacy rows keep their title in the shared shell. No private Confirm payload mounts without actor authority. */
export const approvalCardFamily: CardFamily<"approval"> = {
  approval: { render: () => null, pill: () => "" }
}
