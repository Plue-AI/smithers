/**
 * What one archived journal says a run spent.
 *
 *   node lib/run-cost.mjs <journal-dir-or-engine.db>
 *
 * Prints one JSON object: the seat, the frame and model-call counts, the
 * journal's own span, the four token counters, USD from the committed price
 * table in `prices.ts`, and beside it what the run's Jev readings cost: calls,
 * tokens and `jevUsd`, from `claim-demanded` (the completion brake),
 * `supervisor-settled` (the per-frame supervisor), the `jev` flow's own
 * `cell-call-settled` results and a gate classifier's `decision-settled`.
 * `usd` stays the seat's model spend; `totalUsd` is both. Any other
 * `decision-settled` repeats a reading already metered and is not priced;
 * `jev-usage.ts` owns which rows are which.
 *
 * This reads the journal with `node:sqlite` and nothing else. It deliberately
 * does **not** go through `lib/journal-facts.mjs`, which imports the harness's
 * own modules to rebuild the controller's per-frame decisions: the full
 * benchmark runs for days beside sibling lanes that edit `packages/smithers/agent/harness`,
 * and a cost column that stops working because another lane is mid-edit would
 * stop the benchmark. Cost needs four counters off one event type, so it takes
 * them off one event type.
 *
 * A readable journal with no `model-settled` events reports zero recorded
 * usage. Missing or unreadable journals and calls without a known price carry
 * `unknown: true`, so the budget cannot mistake absent accounting for zero.
 */
import { existsSync, statSync } from "node:fs"
import { jevSources, jevUsageOf } from "../jev-usage.ts"
import { jevModel, usd } from "../prices.ts"
import { journalRows } from "./journal-rows.mjs"

const readJournalCost = (databasePath) => {
  // `control.db` beside the archived `engine.db` holds the `control.*` rows
  // of a current run; `journalRows` reads both (see lib/journal-rows.mjs).
  const rows = journalRows(
    databasePath,
    `event_type in (${
      ["control.agent.model-settled", "control.agent.turn-opened", "control.agent.supervisor-unjudged", ...jevSources]
        .map((eventType) => `'${eventType}'`).join(", ")
    })`
  )

  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  let seat
  let frames = 0
  let modelCalls = 0
  let firstAt
  let lastAt
  let unknown = false
  let dollars = 0
  let priceSource = "no model-settled events"
  const usageBySeat = new Map()
  const jev = { calls: 0, inputTokens: 0, outputTokens: 0, interrupted: 0 }
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    if (firstAt === undefined) firstAt = row.emitted_at_ms
    lastAt = row.emitted_at_ms
    if (row.event_type === "control.agent.turn-opened") {
      frames += 1
      seat = payload.seat
      continue
    }
    if (row.event_type === "control.agent.supervisor-unjudged") {
      // A reading cut off by the run's end was asked and carries no usage:
      // counted, so `jevUsd` reads as the floor it then is.
      if (payload.reason === "interrupted") jev.interrupted += 1
      continue
    }
    if (row.event_type !== "control.agent.model-settled") {
      const metered = jevUsageOf(row.event_type, payload)
      if (metered === undefined) {
        if (
          row.event_type === "control.agent.cell-call-settled" && payload.flowName === "jev" &&
          payload.outcome === "success"
        ) {
          jev.calls += 1
          unknown = true
          priceSource = "unknown: bounded Jev usage"
        }
        continue
      }
      if (![metered.inputTokens, metered.outputTokens].every((value) => Number.isFinite(value) && value >= 0)) {
        unknown = true
        priceSource = "unknown: invalid Jev usage"
        continue
      }
      jev.calls += 1
      jev.inputTokens += metered.inputTokens
      jev.outputTokens += metered.outputTokens
      continue
    }
    modelCalls += 1
    const counters = payload.usage
    if (
      !counters ||
      ![counters.inputTokens, counters.outputTokens, counters.cachedInputTokens ?? 0, counters.reasoningTokens ?? 0]
        .every((value) => Number.isFinite(value) && value >= 0)
    ) {
      unknown = true
      priceSource = "unknown: invalid model usage"
      continue
    }
    usage.inputTokens += payload.usage?.inputTokens ?? 0
    usage.cachedInputTokens += payload.usage?.cachedInputTokens ?? 0
    usage.outputTokens += payload.usage?.outputTokens ?? 0
    usage.reasoningTokens += payload.usage?.reasoningTokens ?? 0
    const seatUsage = usageBySeat.get(seat) ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    seatUsage.inputTokens += counters.inputTokens
    seatUsage.cachedInputTokens += counters.cachedInputTokens ?? 0
    seatUsage.outputTokens += counters.outputTokens
    usageBySeat.set(seat, seatUsage)
  }
  for (const [model, counters] of usageBySeat) {
    const priced = usd(model, counters)
    if (!Number.isFinite(priced.usd)) {
      unknown = true
      priceSource = priced.source
    } else {
      dollars += priced.usd
      if (!unknown) priceSource = priced.source
    }
  }

  // Jev is priced under its own row so the seat's number keeps meaning the
  // seat. Its tokens are never cached, so the cache counter is zero.
  const jevPriced = usd(jevModel, {
    inputTokens: jev.inputTokens,
    cachedInputTokens: 0,
    outputTokens: jev.outputTokens
  })
  const jevUsd = jevPriced.usd ?? 0
  return {
    seat: seat ?? null,
    frames,
    modelCalls,
    spanMillis: firstAt === undefined ? 0 : lastAt - firstAt,
    usage,
    usd: unknown ? null : Math.round(dollars * 10_000) / 10_000,
    jevCalls: jev.calls,
    jevInputTokens: jev.inputTokens,
    jevOutputTokens: jev.outputTokens,
    jevUsd: unknown ? null : jevUsd,
    /** Supervisor readings the run's end interrupted: asked, unmetered, so `jevUsd` is a floor when non-zero. */
    jevInterrupted: jev.interrupted,
    totalUsd: unknown ? null : Math.round((dollars + jevUsd) * 10_000) / 10_000,
    unknown,
    priceSource
  }
}

/**
 * Sums one journal's usage, explicitly marking unreadable accounting unknown.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readCost = (databasePath) => {
  try {
    return readJournalCost(databasePath)
  } catch (error) {
    return { usd: null, unknown: true, priceSource: `unknown: cannot read journal: ${error.message}` }
  }
}

const main = () => {
  const [, , target] = process.argv
  if (target === undefined) {
    console.error("usage: node lib/run-cost.mjs <journal-dir-or-engine.db>")
    process.exit(2)
  }
  const path = existsSync(target) && statSync(target).isDirectory() ? `${target}/engine.db` : target
  process.stdout.write(`${JSON.stringify(readCost(path))}\n`)
}

if (import.meta.filename === process.argv[1]) main()
