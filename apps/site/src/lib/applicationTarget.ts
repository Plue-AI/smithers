import type { ApplicationTargetDocument } from "../../../../packages/rpc/src/ApplicationTarget"

/** The hosted site serves the common API through its stateless same-origin edge. */
export const applicationTarget = {
  apiVersion: 1,
  mode: "web-plue",
  apiOrigin: "",
  auth: { kind: "session" },
  cors: "same-origin",
  developerExternal: false
} satisfies ApplicationTargetDocument
