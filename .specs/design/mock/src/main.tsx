import { createRoot } from "react-dom/client"
import { Player } from "./Player"
import { JOURNEYS } from "./journeys"

/* For check.mjs: every step's viewer, pointer target, shown subjects and spec citation, read without playing. */
;(window as unknown as { __MOCK__: unknown }).__MOCK__ = JOURNEYS.map(journey => ({
  id: journey.id, viewers: journey.viewers,
  steps: journey.steps.map(step => ({ viewer: step.viewer ?? journey.viewers[0], target: step.target ?? null, caption: step.caption, show: step.show ?? [], spec: step.spec ?? null }))
}))

createRoot(document.getElementById("root")!).render(<Player />)
