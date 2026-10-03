/**
 * Which model accounts ran out of credit this session, and what runs instead.
 *
 * A terminal credit refusal marks its model or account spent until the TUI exits: the
 * router skips its models, the model picker says `no credit`, and a worker
 * whose model has none runs once on a known-working model instead, saying so
 * in one line. A model the person pinned is never replaced.
 */
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import * as Providers from "@smthrs/cli/Providers"
import { Option } from "effect"
import { delegateSeat, labelOf, type Model, routeOf } from "./models.ts"

/** Credit refusal codes; timing and scope determine whether they are terminal. */
export const refusals: ReadonlySet<string> = new Set(["quota_exceeded", "out_of_credit"])

/** Whether `error` permanently refused for lack of credit, rather than a timed window. */
export const exhausted = (error: unknown): boolean => {
  const model = QuotaPolicy.modelErrorOf(error)
  return Option.isSome(model) && refusals.has(model.value.code) && QuotaPolicy.isTerminalRefusal(model.value)
}

/** The scope of a normalized credit refusal. */
export const scopeOf = (error: unknown): "model" | "account" => {
  const model = QuotaPolicy.modelErrorOf(error)
  return Option.isSome(model) && model.value.quotaScope === "model" ? "model" : "account"
}

/** `↪ GPT-6.1 Sol has no credit · using Qwen 3.8`: the one line a worker shows when it runs elsewhere. */
export const notice = (from: string, to: string, models: ReadonlyArray<Model> = []): string =>
  `↪ ${labelOf(from, models)} has no credit · using ${labelOf(to, models)}`

export interface Ledger {
  /** Records a terminal credit refusal for a model or account. */
  readonly spend: (seat: string, scope?: "model" | "account") => void
  /** Records that `seat` answered. */
  readonly answered: (seat: string) => void
  /** Whether `seat` is covered by a terminal credit refusal this session. */
  readonly spent: (seat: string) => boolean
  /** The account `seat` runs on (`openai`, `anthropic`, `claude-code`): what a failure names. */
  readonly account: (seat: string) => string
  /**
   * The seat to run once in place of `seat` when its account has no credit:
   * the latest seat that answered, else `chat`, on an account that has not
   * refused. `Seat.auto` has none only when every routed model's account
   * refused. Undefined when `seat` has credit or nothing known works.
   */
  readonly instead: (seat: string, chat: string) => { readonly from: string; readonly to: string } | undefined
  /** `↪ GPT-6.1 Sol has no credit · using Qwen 3.8`. */
  readonly notice: (from: string, to: string) => string
}

/**
 * A session's ledger over the `models` this machine offers. `routed` are the
 * seats an `auto` worker routes over, in the router's order.
 */
export const make = (models: ReadonlyArray<Model>, routed: ReadonlyArray<string> = []): Ledger => {
  const spentRoutes = new Set<string>()
  const spentModels = new Set<string>()
  /** Seats refused, oldest first: an `auto` worker names the latest one that it routes over. */
  const refused: Array<string> = []
  const worked: Array<string> = []
  const route = (seat: string) => routeOf(seat, models)
  const model = (seat: string) => {
    const alias = seat.startsWith("claude-code:") ? seat.slice("claude-code:".length) : seat
    return `${route(seat)}:${(Providers.seatAliases[alias] ?? delegateSeat(alias)).split(":").at(-1)}`
  }
  const spent = (seat: string) => seat !== Seat.auto && (spentRoutes.has(route(seat)) || spentModels.has(model(seat)))
  return {
    spend: (seat, scope = "account") => {
      if (seat === Seat.auto) return
      if (scope === "model") spentModels.add(model(seat))
      else spentRoutes.add(route(seat))
      refused.push(seat)
    },
    answered: (seat) => {
      if (seat === Seat.auto) return
      const at = worked.indexOf(seat)
      if (at >= 0) worked.splice(at, 1)
      worked.push(seat)
    },
    spent,
    account: route,
    instead: (seat, chat) => {
      const from = seat !== Seat.auto
        ? spent(seat) ? seat : undefined
        : routed.length > 0 && routed.every(spent)
        ? refused.findLast((each) =>
          routed.some((alias) =>
            model(alias) === model(each) || (spentRoutes.has(route(each)) && route(alias) === route(each))
          )
        ) ?? routed[0]
        : undefined
      if (from === undefined) return undefined
      const to = [...worked.toReversed(), chat].find((each) => each !== Seat.auto && !spent(each))
      return to === undefined ? undefined : { from, to }
    },
    notice: (from, to) => notice(from, to, models)
  }
}
