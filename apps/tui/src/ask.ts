/**
 * Headless probe: runs one turn and prints each non-delta event and the outcome
 * as complete JSON lines.
 *
 *   bun src/ask.ts "list the files here" [seat]
 */
import { appendFileSync, writeFileSync } from "node:fs"
import * as Approvals from "./approvals.ts"
import * as Budget from "./budget.ts"
import * as Host from "./host.ts"
import * as Models from "./models.ts"
import * as Spend from "./spend.ts"

const prompt = process.argv[2]
if (prompt === undefined) {
  console.error("usage: bun src/ask.ts \"<prompt>\" [seat]")
  process.exit(2)
}
// SMITHERS_TUI_RECORD=file.jsonl records every event with its arrival time.
const record = process.env.SMITHERS_TUI_RECORD
if (record !== undefined) writeFileSync(record, "")
const available = await Models.detect(process.env)
const approvals = Approvals.mode(process.env, { print: true })
if (typeof approvals === "object") {
  console.error(approvals.error)
  process.exit(2)
}
const budget = Budget.policy(process.env)
if (budget !== undefined && "error" in budget) {
  console.error(budget.error)
  process.exit(2)
}
const host = Host.make({
  cwd: process.cwd(),
  environment: available.environment,
  available,
  approvals,
  ...(budget === undefined ? {} : { budget, ledger: Spend.ledger() })
})
const turn = host.run({
  prompt,
  seat: process.argv[3] ?? available.defaultSeat ?? "openai:gpt-6-sol",
  history: [],
  onEvent: (event) => {
    if (record !== undefined) appendFileSync(record, JSON.stringify({ at: Date.now(), event }) + "\n")
    const { _tag, ...rest } = event as unknown as { _tag: string } & Record<string, unknown>
    if (_tag === "model-delta") return
    console.log(JSON.stringify({ _tag, ...rest }))
  }
})
const outcome = await turn.done
console.log(JSON.stringify(outcome))
await host.dispose()
process.exit(outcome._tag === "done" ? 0 : 1)
