import { payloadFor } from "./SlashPayload"
/** Recorded workspace catalogs retain the branch-bound read under /flows. */
export const workspaceFlowsArgs = (args = ""): string => {
  const parsed = payloadFor("flow.list", args)
  return JSON.stringify({ ...("payload" in parsed ? parsed.payload : {}), operation: "workspace" })
}
