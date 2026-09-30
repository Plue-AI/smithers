/**
 * The chat flow against a recorded model.
 *
 * `cachedModelTest` replays `./fixtures/balance.json`, so this runs offline and
 * the same model turn is graded on every commit. Re-record against the live
 * seat with `SMTHRS_RECORD=1 pnpm test`; the fixture is written back on a miss.
 * A recording reads the key for the provider the seat names, so the seat in
 * AGENT.ts and the key in the environment have to be the same provider.
 *
 * The card assertion reads the sink, not the output. `cards` in the flow's
 * output is the model reporting what it thinks it emitted, and a model that
 * answered in prose can still name a card there. `routedFlows` binds `ui` to
 * `cards` below, so a `kind: "pane"` entry means `ui/pane` ran and the card
 * registry accepted the pane name.
 */
import { cachedModelTest } from "@smthrs/create-app/testing"
import type { AppCard } from "@smthrs/create-app/ui"
import { Agent } from "../../AGENT.ts"
import { liveModel } from "../../test/support/liveModel.ts"
import { routedFlows } from "../../test/support/routedFlows.ts"
import Flow from "./flow.ts"

type Payload = typeof Flow.payloadSchema.Type
type Output = typeof Flow.successSchema.Type

/** Every card the turn's `ui/*` calls emitted, in emission order. */
const cards: Array<AppCard> = []

cachedModelTest<Payload, Output>("chat answers a balance question with a pane", {
  fixture: new URL("./fixtures/balance.json", import.meta.url),
  flow: "chat",
  payload: { message: "What is vitalik.eth's ETH balance on mainnet?" },
  // The seat is read from the resolved AGENT.ts, so a recording always runs on
  // the model the app declares.
  live: () => liveModel(Agent.seat),
  routes: async () => routedFlows(cards),
  expect: (output) => {
    if (output.answer.trim().length === 0) throw new Error("chat returned an empty answer")
    if (!cards.some((card) => card.kind === "pane")) {
      throw new Error(
        `chat answered a balance question without requesting a ui/pane card. Cards emitted: ${
          JSON.stringify(cards.map((card) => card.kind))
        }`
      )
    }
    if (output.cards.length === 0) {
      throw new Error("chat emitted a card but reported none in `cards`")
    }
  }
})
