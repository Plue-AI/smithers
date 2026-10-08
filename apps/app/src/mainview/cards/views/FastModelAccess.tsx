import type { SetupCard } from "@smthrs/rpc/SetupCard"
import type { Action, CardProps } from "@smthrs/rpc/CardAction"
import { SetupActions } from "./SetupActions"

export const FAST_MODEL_DISCLOSURE = "App prompts, preflight and summaries go to Smithers and Cerebras. Smithers keeps token counts only. Use your own key to bypass Smithers."
const resetTime = (value: string) => {
 const date = new Date(value)
 return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(11,16)} UTC`
}
export function FastModelAccess({ status, actions, onAction }: { readonly status: SetupCard["fast_model"]; readonly actions: readonly Action[]; readonly onAction: CardProps<unknown>["onAction"] }) {
 if (!status) return null
 const cause = status.cause === "capacity" ? "daily Smithers quota used" : status.cause === "refused" ? "Smithers credential refused" : "Smithers unreachable"
 return <div data-testid="fast-model-access">
  <span>{status.signed_in ? "Signed in" : "Not signed in"}</span>{" "}
  <span>{status.source}</span>
  {status.remaining !== undefined && <span>{status.remaining} tokens left{status.reset_at ? ` · ${resetTime(status.reset_at)}` : ""}</span>}
  {status.cause && <span role="status">Fast model: {cause}; using {status.source}{status.reset_at ? ` until ${resetTime(status.reset_at)}` : ""}</span>}
  <SetupActions inline actions={actions.filter(action => action.tag === "settings" && action.args?.operation === "fast-model")} onAction={onAction} />
  <small>{FAST_MODEL_DISCLOSURE}</small>
 </div>
}
