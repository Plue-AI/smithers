/**
 * Reads a liveness workspace's journal and reports whether the read-only
 * control acted.
 *
 *   node lib/check-liveness.mjs <workspace>
 *
 * Exits 0 only when the journal contains at least one
 * `control.agent.read-only-demanded`. Everything else it prints is the context
 * that makes that answer readable: what the run armed, the per-frame mutation
 * record the cap counts, whether any transition carried a `justification`, and
 * what the frames cost.
 *
 * The justification column is the point. A run in which the streak reached the
 * cap and no demand was journaled is not evidence that the control is dead; it
 * is evidence that something satisfied the demand first, and this prints which.
 *
 * @since 0.1.0
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { usd } from "../prices.ts"

const workspace = process.argv[2]
if (workspace === undefined) {
  console.error("check-liveness.mjs: usage: check-liveness.mjs <workspace>")
  process.exit(2)
}

const rows = []
for (const file of ["engine.db", "control.db"]) {
  const path = join(workspace, ".flows", file)
  if (!existsSync(path)) continue
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    rows.push(
      ...database.prepare(
        "select run_id, seq, event_type, payload_json from flows_journal_events order by run_id, seq"
      ).all()
    )
  } catch {
    // A journal without the events table is a workspace that never ran.
  }
  database.close()
}
const seen = new Set()
const events = rows.filter((row) => {
  const key = `${row.run_id}\u0000${row.seq}\u0000${row.event_type}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
}).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }))

if (events.length === 0) {
  console.error(`check-liveness.mjs: no journal under ${workspace}/.flows`)
  process.exit(2)
}

const of = (type) => events.filter((event) => event.event_type === type)
const armed = of("control.agent.discipline-armed")[0]?.payload
const mutations = of("control.agent.mutation-observed").map((event) => event.payload)
const transitions = of("control.agent.transition-applied").map((event) => event.payload.transition)
const demands = of("control.agent.read-only-demanded").map((event) => event.payload)

// The counter the harness keeps, replayed from the events it wrote: a settled
// frame that changed nothing extends the streak, a frame that changed
// something clears it.
let streak = 0
let longest = 0
for (const mutation of mutations) {
  streak = mutation.mutated ? 0 : streak + 1
  longest = Math.max(longest, streak)
}
const justified = transitions.filter((transition) => (transition.justification ?? "").trim().length > 0).length

const tokens = of("control.agent.model-settled").reduce((total, event) => ({
  inputTokens: total.inputTokens + (event.payload.usage?.inputTokens ?? 0),
  cachedInputTokens: total.cachedInputTokens + (event.payload.usage?.cachedInputTokens ?? 0),
  outputTokens: total.outputTokens + (event.payload.usage?.outputTokens ?? 0)
}), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })
const seat = of("control.agent.turn-opened")[0]?.payload.seat
const priced = usd(seat, tokens)

console.log(`seat            ${seat ?? "unrecorded"}`)
console.log(`armed           readOnlyCap=${armed?.readOnlyCap ?? "unrecorded"} maxFrames=${armed?.maxFrames ?? "?"}`)
console.log(`frames settled  ${mutations.length}`)
console.log(`longest streak  ${longest}`)
console.log(`justifications  ${justified} transition(s) carried one`)
console.log(
  `tokens          ${tokens.inputTokens} in (${tokens.cachedInputTokens} cached), ${tokens.outputTokens} out`
)
console.log(`cost            ${priced.usd === undefined ? priced.source : `$${priced.usd.toFixed(4)}`}`)
console.log(`demands         ${demands.length}`)
for (const demand of demands) {
  console.log(
    `  read-only-demanded streak=${demand.streak} cap=${demand.cap} nextFrame=${demand.nextFrame} `
      + `nextAction=${demand.nextAction}`
  )
}

if (demands.length > 0) {
  console.log("check-liveness.mjs: the read-only control fired and reached the journal.")
  process.exit(0)
}
if (longest < (armed?.readOnlyCap ?? Number.POSITIVE_INFINITY)) {
  console.error(
    `check-liveness.mjs: INCONCLUSIVE — the run never reached the cap `
      + `(longest streak ${longest}, cap ${armed?.readOnlyCap ?? "unrecorded"}). The probe stopped early.`
  )
  process.exit(3)
}
console.error(
  justified > 0
    ? `check-liveness.mjs: FAILED — the streak reached the cap and no demand was journaled, and `
      + `${justified} transition(s) carried a justification. An unsolicited justification satisfies the `
      + `demand before it is issued, which is the wave-6 finding reproduced.`
    : "check-liveness.mjs: FAILED — the streak reached the cap, nothing justified it, and no demand was journaled."
)
process.exit(1)
