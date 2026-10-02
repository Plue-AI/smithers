/** The clock is injected so intake tests can exercise hourly boundaries. */
export interface BugWorkerDeps {
  now: () => number;
}
