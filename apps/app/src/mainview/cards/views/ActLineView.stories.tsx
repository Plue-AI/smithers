import { ActLineView, type ActLineProps } from "./ActLineView"
import { actorName } from "./actorName"
import { ben, codex } from "@smthrs/rpc/fixtures/_shared"
import type { ViewStory } from "./stories"
import "../../styles/base.css"
import "../../styles/chat.css"

/* Participant labels come from the shared formatter (ActorLabels conformance). */
const codexForBen = actorName({ ...codex, for_member: ben })
const models: Record<string, ActLineProps> = {
  plain: { line: "Smithers ran 1 command", steps: [] },
  with_steps: { line: `${codexForBen} ran 2 commands`, steps: [{ text: "rg reset-token", status: "ok" }, { text: "pnpm test reset-token", status: "running", output: "Running checks" }] },
  with_error: { line: `${codexForBen} ran 1 command · 1 failed`, tone: "failed", steps: [{ text: "pnpm test reset-token", status: "error", output: "FAIL reset-token.test.ts", exit_code: 1 }] }
}
export const stories: ViewStory[] = Object.entries(models).map(([name, model]) => ({ name, expect: [model.line], render: () => <ActLineView {...model} /> }))
