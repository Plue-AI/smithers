// History writes/readback still need real-host receipts: https://github.com/smithersai/smithers/issues/1921.
// The Stack card these specs drove was deleted with the Home mount; the stack's real-host spec follows the `home` topic.
export const history = [
  "history.bootstrap",
] as const

/** Retired legacy scenarios, not passing replacement-command evidence.
 * Owner: smithers-b8; replacement real-host journeys remain owed in deferrals.ts (#2290).
 * Frontrun 263c41d3d8: d46762b2c8 retires PR Land; 260cb49720 retires commit cards.
 */
export const RETIRED_SCENARIOS = [
  { id: "pull-requests.production-land-git-proof", actions: ["prs.land"], reason: "M-39 / Appendix B: person-reviewed /merge Tn replaces legacy PR queue landing; todo-merge.spec.ts owns the reference-host door" },
  { id: "pull-requests.production-stale-land-action", actions: ["prs.land"], reason: "M-39: the retired PR Land button cannot prove stale TODO merge confirmation behavior" },
  { id: "landings.local-change-land", actions: ["prs.land"], reason: "M-05, M-39: imported local changes are not TODOs; /merge takes a TODO, not a PR number and repository; todo-merge.spec.ts owns the reference-host replacement" },
  { id: "landings.change-card-land", actions: ["change.land"], reason: "M-39: legacy Change Land removed; person-reviewed TODO merge replacement remains owed" },
  { id: "runs.live-steering-durable-reconnect", actions: ["runs.steer"], reason: "Appendix B: /todo.steer Tn replaces TODO steering; this arbitrary flow run has no TODO identity, owner smithers-b8 owes replacement evidence (#2290)" },
  { id: "repository.branches-commits-readback", actions: ["branches.list", "commits.list", "commits.read"], reason: "Appendix B: /branches with history inside Branch replaces deleted commit cards (260cb49720); owner smithers-b8 owes current Branch keyboard/readback evidence (#2290)" },
] as const
