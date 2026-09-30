/**
 * The chat flow against a recorded model.
 *
 * `cachedModelTest` replays `./fixtures/answer.json`, so this runs offline,
 * with no provider key, and grades the same model turn on every commit.
 *
 * Re-recording needs a `live` option: a function returning a `Model` bound to
 * a real provider. This template ships none, because a live model pulls in
 * `@smthrs/model` and a credential path that a first app does not need to run
 * its tests. The `aomi` template's `test/support/liveModel.ts` is the worked
 * example. Add one, pass `live`, and `SMTHRS_RECORD=1 vitest run` rewrites this
 * fixture; a recording that fails leaves the committed one alone.
 *
 * The card assertion reads `collectedCards`, not the flow's output. `cards` in
 * the output is the model reporting what it thinks it emitted, and a model that
 * answered in prose can still name a card there. `collectedCards` is the sink
 * `TOOLS.ts` bound, so an entry in it means `ui/pane` actually ran and the pane
 * registry accepted the name. `resetCollectedCards` runs before each test, so
 * the assertion sees only the cards this test's run emitted.
 */
import { fileURLToPath } from "node:url"
import { cachedModelTest } from "@smthrs/create-app/testing"
import { beforeEach } from "vitest"
import { collectedCards, resetCollectedCards } from "../../tools/ui.ts"
import Flow from "./flow.ts"

beforeEach(resetCollectedCards)

type Payload = typeof Flow.payloadSchema.Type
type Output = typeof Flow.successSchema.Type

cachedModelTest<Payload, Output>("chat answers a question and renders a pane", {
  fixture: new URL("./fixtures/answer.json", import.meta.url),
  flow: "chat",
  root: fileURLToPath(new URL("../..", import.meta.url)),
  payload: { message: "What does durable execution buy me?" },
  expect: (output) => {
    if (output.answer.trim().length === 0) throw new Error("chat returned an empty answer")
    if (!collectedCards.some((card) => card.kind === "pane")) {
      throw new Error(
        `chat answered without rendering a pane. Cards emitted: ${
          JSON.stringify(collectedCards.map((card) => card.kind))
        }`
      )
    }
    if (output.cards.length === 0) throw new Error("chat emitted a card but reported none in `cards`")
  }
})
