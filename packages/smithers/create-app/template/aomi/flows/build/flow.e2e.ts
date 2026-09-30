/**
 * The build flow against a recorded model.
 *
 * The pipeline is long, so the fixture is what makes it testable at all: the
 * recorded turn replays in milliseconds and the plan it produces is graded
 * field by field. Re-record with `SMTHRS_RECORD=1 pnpm test`, which reads the
 * key for the provider `flows/build/AGENT.ts` names.
 *
 * `routedFlows` supplies the routes so `ui/pane` sees the registered pane list
 * rather than the empty one TOOLS.ts composes. Build renders what it planned,
 * and a run that spends frames being refused by name is not the run the fixture
 * should hold.
 */
import { cachedModelTest } from "@smthrs/create-app/testing"
import type { AppCard } from "@smthrs/create-app/ui"
import { liveModel } from "../../test/support/liveModel.ts"
import { routedFlows } from "../../test/support/routedFlows.ts"
import { Agent } from "./AGENT.ts"
import Flow from "./flow.ts"

type Payload = typeof Flow.payloadSchema.Type
type Output = typeof Flow.successSchema.Type

/** Every card the run's `ui/*` calls emitted, in emission order. */
const cards: Array<AppCard> = []

cachedModelTest<Payload, Output>("build plans a balance viewer without shipping it", {
  fixture: new URL("./fixtures/balance-viewer.json", import.meta.url),
  flow: "build",
  payload: {
    app: "balance-viewer",
    prompt: "A page that shows the ETH balance of an address the user types.",
    source: "new"
  },
  // flows/build/AGENT.ts is the nearest ancestor, so a recording runs on the
  // build seat and not on the root chat one.
  live: () => liveModel(Agent.seat),
  routes: async () => routedFlows(cards),
  expect: (output) => {
    if (output.files.length === 0) throw new Error("build produced a plan with no files")
    if (!output.steps.some((step) => step.name === "validate")) {
      throw new Error("build skipped the validate stage")
    }
    if (output.shipUrl !== undefined) {
      throw new Error("build reported a shipUrl for a run with no approved deploy")
    }
  }
})
