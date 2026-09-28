import { defineTools } from "@smthrs/create-app/app"
import { promote } from "./tools/promote.ts"
import { tevm } from "./tools/tevm.ts"
import { ui } from "./tools/ui.ts"

// Root tool layer: the FlowBinding sources every flow below this directory
// reaches as ctx.call("<source>/<flow>", input). These mock sources need no network
// grant. flows/write-flow saves promoted flows, so writing under /flows/ is granted;
// drop the grant to stop the agent saving flows.
export const Tools = defineTools({
  sources: [tevm, ui, promote],
  grant: [{ action: "fs:write", resource: "/flows/**" }]
})
