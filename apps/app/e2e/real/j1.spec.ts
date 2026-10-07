import { activationJourney } from "./support/activationJourney"
import { scenario } from "./coverage/types"

const { test, run } = activationJourney("release")
// First-TODO slice; the keyboard slice alone cannot qualify C-UI-01.
test("C-J1-04 first TODO release", scenario("journey.j1-release", {
  capabilities: [], coverage: ["action:sign-in", "dimension:activation", "host:local", "host:production", "path:success", "door:button", "evidence:activation"]
}), run)
