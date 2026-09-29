import type { ChatUsage } from "./state/AppState"
import { knownContextWindowTokens } from "@smthrs/model/ModelCatalog"
import { runMeterLabel, runMeterParts, type RunMeter } from "./cards/RunMeter"

/**
 * The conversation's meter as a RunMeter: the window comes from the chat
 * model when the catalog knows it. Undefined for another conversation's
 * usage, so a cleared or switched conversation shows nothing.
 */
export const chatMeterOf = (usage: ChatUsage | undefined, branchId: string): RunMeter | undefined =>
  usage === undefined || usage.branchId !== branchId ? undefined : {
    input: usage.input,
    output: usage.output,
    cached: usage.cached,
    context: usage.context,
    window: usage.modelId === undefined ? undefined : knownContextWindowTokens(usage.modelId)
  }

/** The chat bar's context and cache meter, `7.9%/128k · cache 94%`; nothing when neither part is known. */
export function ChatMeter({ usage, branchId }: { readonly usage: ChatUsage | undefined; readonly branchId: string }) {
  const meter = chatMeterOf(usage, branchId)
  if (meter === undefined) return null
  const parts = runMeterParts(meter)
  if (parts.window === undefined && parts.cache === undefined) return null
  return (
    // role="img" so the label, which says the levels in words, is what a screen reader reads.
    <span className="chat-meter run-meter" data-testid="chat-meter" role="img" aria-label={runMeterLabel(meter)}>
      {parts.window === undefined ? null : (
        <span data-level={parts.windowDanger ? "danger" : undefined}>{parts.window}</span>
      )}
      {parts.window === undefined || parts.cache === undefined ? null : " · "}
      {parts.cache === undefined ? null : (
        <span data-level={parts.cacheWarning ? "warning" : undefined}>{parts.cache}</span>
      )}
    </span>
  )
}
