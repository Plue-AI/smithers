import { FlowRuntime } from "@smthrs/flow"
import { Schema } from "effect"

const identityConflict = Schema.is(FlowRuntime.ExecutionIdentityConflict)
/** A fresh work identity is safe only after the existing child is terminal. */
export const terminalIdentityConflict = (error: unknown): error is FlowRuntime.ExecutionIdentityConflict =>
  identityConflict(error) && (error.status === "completed" || error.status === "failed" || error.status === "cancelled")
