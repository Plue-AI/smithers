/**
 * Worker action eligibility shared by browser and terminal adapters.
 *
 * @since 1.0.0
 */

/**
 * Worker state shared across hosts.
 * @since 1.0.0
 * @category models
 */
export type Status = "requested" | "queued" | "running" | "waiting" | "parked" | "done" | "failed" | "cancelled"
/**
 * Worker controls; adapters expose only operations their host supports.
 * @since 1.0.0
 * @category models
 */
export type Action =
  | "stop"
  | "retry"
  | "model"
  | "wait"
  | "steer"
  | "thinking"
  | "resume"
  | "inspect"
  | "approval"

/**
 * Whether the worker has unfinished work.
 * @since 1.0.0
 * @category predicates
 */
export const live = (status: Status): boolean =>
  status === "requested" || status === "queued" || status === "running" || status === "waiting" || status === "parked"

/**
 * Check state eligibility before the host binds an action to its own transport.
 * @since 1.0.0
 * @category predicates
 */
export const allowed = (action: Action, worker: {
  readonly status: Status
  readonly failure?: { readonly actions: ReadonlyArray<string> }
  readonly liveModelSwitch?: boolean
}): boolean => {
  switch (action) {
    case "stop":
      return live(worker.status)
    case "retry":
      return worker.status === "failed" || worker.status === "cancelled"
    case "model":
      return worker.status === "failed" ||
        worker.liveModelSwitch === true && (worker.status === "running" || worker.status === "parked")
    case "wait":
      return worker.status === "failed" && worker.failure?.actions.includes("wait") === true
    case "steer":
      return worker.status === "running"
    case "thinking":
      return worker.status === "running" || worker.status === "parked"
    case "resume":
      return worker.status === "waiting" || worker.status === "parked"
    case "approval":
      return worker.status === "waiting"
    case "inspect":
      return true
  }
}
