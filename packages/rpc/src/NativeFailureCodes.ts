/**
 * The native app host's OWN failure taxonomy — the refusals apps/app/src/bun
 * writes on the routes only it serves.
 *
 * This is the THIRD vocabulary. plue's is generated and vendored
 * (PlueFailureCodes.ts); the Cloudflare Worker's is hand-written beside it
 * (WorkerFailureCodes.ts); and the host's private routes — repositories,
 * targets, terminals, code intel, agents — answered `{ error: { code, message } }`
 * with nothing classified at all. Every one of them reached the app as
 * `code: null` with its fault guessed from the status, so `503 node_missing`
 * ("no Node on this box") guessed `infra`, whose copy is "Smithers ran out of
 * infra, yell at @fucory to buy more" — a claim about our fleet made about a
 * laptop that simply has no Node on it.
 *
 * The codes ARE prefixed here, where the Worker's are not. The Worker could
 * keep a gate instead of a prefix because its spellings happened to be free;
 * these are not. Eight of the host's route names are already spelled by plue —
 * `not_found`, `invalid_path`, `invalid_json`, `invalid_request`,
 * `unsupported_media_type`, `language_server_missing`, `not_implemented`,
 * `internal` — and one by the Worker (`method_not_allowed`), and they do not
 * all mean the same thing: plue's `not_implemented` is a `bug` ("the route
 * exists but its implementation does not"), while this host's is a build that
 * does not carry a seam. Renaming the route names instead would break the
 * envelope this host's clients and its docs already read
 * (apps/app/docs/LOCAL-APP.md, `LspClient` matching `language_server_missing`).
 * So a route keeps its bare name inside `error.code`, and the CLASSIFIED code
 * beside it is that name in this namespace: `repo_not_found` is the route's,
 * `native_repo_not_found` is the refusal's.
 *
 * `native_` and not `host_` or `local_`: plue spends `host_` on the machine
 * running a coding guest (`host_lease_lost`), and naming the wrong machine is
 * the mistake `worker_` would have made in WorkerFailureCodes.ts; `local_` is
 * already a route name here (`local_session_required`). The ORIGIN these
 * arrive under is still `local` (Refusal.ts) — the code says which program
 * wrote the refusal, the origin says which machine it ran on.
 *
 * NO row here is `infra`. That fault's copy is about Smithers' own fleet being
 * full, and there is no fleet inside a program on the reader's own box: a host
 * that failed at its own job is a `bug`, a program it needed and could not
 * find or start is a `dependency`, the request or the box's state is `user`,
 * and none of it is fixed by buying more of anything.
 * test/NativeFailureCodes.test.ts holds that line beside the three-way
 * disjointness gate.
 *
 * @since 1.0.0
 */

import type { PlueFault } from "./PlueFailureCodes.ts"

/**
 * The namespace every one of this host's codes wears on the wire.
 *
 * @since 1.0.0
 * @category constants
 */
export const NATIVE_CODE_PREFIX = "native_"

/**
 * Every route name the native host may put in its `{ error: { code, message } }`
 * envelope.
 *
 * @since 1.0.0
 * @category constants
 */
export const NATIVE_ROUTE_CODES = [
  "agent_unavailable",
  "bad_cwd",
  "body_too_large",
  "builtin_agent",
  "builtin_harness_fixed",
  "capacity_reached",
  "cloud_auth_unavailable",
  "cloud_sign_in_required",
  "confirm_stale",
  "file_too_large",
  "harness_no_model_flag",
  "harness_unavailable",
  "internal",
  "invalid_host",
  "invalid_id",
  "invalid_json",
  "invalid_name",
  "invalid_origin",
  "invalid_path",
  "invalid_request",
  "invalid_source",
  "language_server_busy",
  "language_server_failed",
  "language_server_missing",
  "language_server_timeout",
  "language_unsupported",
  "local_session_required",
  "manager_closed",
  "manual_repository_paths_disabled",
  "method_not_allowed",
  "node_missing",
  "not_a_directory",
  "not_found",
  "not_implemented",
  "path_not_found",
  "path_outside_repository",
  "read_failed",
  "repo_not_found",
  "repository_access_not_saved",
  "repository_authorization_failed",
  "repository_authorization_invalid",
  "repository_creation_failed",
  "repository_read_denied",
  "repository_read_only",
  "role_unlaunchable",
  "run_not_found",
  "source_not_found",
  "spa_missing",
  "spawn_failed",
  "target_graph_unavailable",
  "target_not_found",
  "target_run_capacity",
  "target_stale",
  "turn_running",
  "unknown_harness",
  "unknown_role",
  "unsupported_media_type",
  "upgrade_failed"
] as const

/**
 * A route name in the host's own envelope, under `error.code`.
 *
 * @since 1.0.0
 * @category models
 */
export type NativeRouteCode = (typeof NATIVE_ROUTE_CODES)[number]

/**
 * A code the native host refuses with, as the app's classifier reads it.
 *
 * @since 1.0.0
 * @category models
 */
export type NativeFailureCode = `${typeof NATIVE_CODE_PREFIX}${NativeRouteCode}`

/**
 * One row of the host's taxonomy: the same three facts per row as plue's and
 * the Worker's, each meaning the same thing.
 *
 * @since 1.0.0
 * @category models
 */
export interface NativeFailureEntry {
  /** Whose problem this is. Never `infra`: a program on the reader's box has no fleet to run out of. */
  readonly fault: PlueFault
  /**
   * The status this host answers for the code. `jsonError` reads it from here
   * so a route and its code cannot drift apart, and a refusal recovered from
   * the code alone carries the same one.
   */
  readonly status: number
  /** Seconds before this is worth asking again; 0 when waiting changes nothing, exactly as plue's rows spell it. */
  readonly retryAfter: number
}

/**
 * The host's registry. `satisfies Record<NativeRouteCode, NativeFailureEntry>`
 * is the exhaustiveness gate: a route code with no row, or a row for a code
 * not in the list, does not compile.
 *
 * @since 1.0.0
 * @category constants
 */
export const NATIVE_FAILURES = {
  /** This build runs no agent provider (offline mode), so the turn routes have nothing to hand a turn to. */
  "agent_unavailable": { fault: "user", status: 503, retryAfter: 0 },
  /** A terminal asked to start in a directory that is not one. */
  "bad_cwd": { fault: "user", status: 400, retryAfter: 0 },
  /** A body past the route's byte ceiling, measured in bytes received, so a chunked body is refused too. */
  "body_too_large": { fault: "user", status: 413, retryAfter: 0 },
  /** The confirmation revision changed or the confirmation has already been answered. */
  "confirm_stale": { fault: "user", status: 409, retryAfter: 0 },
  /** A built-in agent cannot be removed; its model and purpose can still be edited. */
  "builtin_agent": { fault: "user", status: 409, retryAfter: 0 },
  /** A built-in agent keeps the harness it ships with. */
  "builtin_harness_fixed": { fault: "user", status: 409, retryAfter: 0 },
  /** Every terminal session this host allows at once is in use. Closing one is the fix, so waiting alone is not. */
  "capacity_reached": { fault: "user", status: 429, retryAfter: 0 },
  /** The Smithers Cloud sign-in could not be started from the state this host is in — already signed in, or a callback listener that never opened. */
  "cloud_auth_unavailable": { fault: "user", status: 409, retryAfter: 0 },
  /** A cloud route with no Smithers Cloud credential held by this host. */
  "cloud_sign_in_required": { fault: "user", status: 401, retryAfter: 0 },
  /** A file past the language server's read cap. */
  "file_too_large": { fault: "user", status: 413, retryAfter: 0 },
  /** The named harness takes no model flag, so an agent cannot pin a model on it. */
  "harness_no_model_flag": { fault: "user", status: 400, retryAfter: 0 },
  /** That harness is not installed on this box. Another one, or installing it, is the way through. */
  "harness_unavailable": { fault: "user", status: 400, retryAfter: 0 },
  /** A route threw where no contract names the failure. Logged with its stack, answered with its message. */
  "internal": { fault: "bug", status: 500, retryAfter: 0 },
  /** A request whose Host header is not this loopback origin. */
  "invalid_host": { fault: "user", status: 421, retryAfter: 0 },
  /** An id that is not the shape that kind of id has. */
  "invalid_id": { fault: "user", status: 400, retryAfter: 0 },
  /** A body that is not valid JSON. */
  "invalid_json": { fault: "user", status: 400, retryAfter: 0 },
  /** A name this route cannot accept — a repository's, an agent's. */
  "invalid_name": { fault: "user", status: 400, retryAfter: 0 },
  /** A browser request whose Origin is not the local app's. */
  "invalid_origin": { fault: "user", status: 403, retryAfter: 0 },
  /** A path that is not valid percent-encoded UTF-8, or not one this host will read. */
  "invalid_path": { fault: "user", status: 400, retryAfter: 0 },
  /** The request is missing a field, or carries one this route cannot accept. */
  "invalid_request": { fault: "user", status: 400, retryAfter: 0 },
  /** A declaration source that is not one of the open repository's own. */
  "invalid_source": { fault: "user", status: 400, retryAfter: 0 },
  /** The language server has every request in flight it will take. Nothing is broken; it is not free yet. */
  "language_server_busy": { fault: "wait", status: 429, retryAfter: 0 },
  /** A language server left, or answered in a way its protocol does not allow. */
  "language_server_failed": { fault: "dependency", status: 502, retryAfter: 0 },
  /**
   * No language server for this file is installed on this box. plue calls its
   * own row `user`; here it is the box missing a program the host needs, and
   * the message is the install line verbatim — nothing installs it.
   */
  "language_server_missing": { fault: "dependency", status: 409, retryAfter: 0 },
  /** A language server took longer than the request's bound. */
  "language_server_timeout": { fault: "dependency", status: 504, retryAfter: 0 },
  /** No row of the language registry handles this file's extension. */
  "language_unsupported": { fault: "user", status: 400, retryAfter: 0 },

  /** The per-launch local session capability was absent or wrong. Never a person's Smithers session. */
  "local_session_required": { fault: "user", status: 401, retryAfter: 0 },
  /** The terminal manager is closed: the host is stopping, or this repository was closed under it. */
  "manager_closed": { fault: "user", status: 503, retryAfter: 0 },
  /** Typed repository paths are off in this build; repositories arrive through the folder picker. */
  "manual_repository_paths_disabled": { fault: "user", status: 403, retryAfter: 0 },
  /** The route exists, this verb does not. */
  "method_not_allowed": { fault: "user", status: 405, retryAfter: 0 },
  /** No Node this host can use for the sidecar a target run needs. */
  "node_missing": { fault: "dependency", status: 503, retryAfter: 0 },
  /** A path that exists and is not a directory where one was required. */
  "not_a_directory": { fault: "user", status: 400, retryAfter: 0 },
  /** No route of this host answers that path, or the entity a route names does not exist. */
  "not_found": { fault: "user", status: 404, retryAfter: 0 },
  /** The route exists and this build does not carry what answers it. NOT plue's `not_implemented`, which is a defect. */
  "not_implemented": { fault: "user", status: 501, retryAfter: 0 },
  /** No file or directory at that path inside the repository. */
  "path_not_found": { fault: "user", status: 404, retryAfter: 0 },
  /** A path that resolves outside the repository it was asked for. */
  "path_outside_repository": { fault: "user", status: 403, retryAfter: 0 },
  /** The host could not read a file it had every right to read. */
  "read_failed": { fault: "bug", status: 500, retryAfter: 0 },
  /** No open repository with that id. */
  "repo_not_found": { fault: "user", status: 404, retryAfter: 0 },
  /** The grant changed and the host could not write the change down; the next launch would disagree with this one. */
  "repository_access_not_saved": { fault: "bug", status: 500, retryAfter: 0 },
  /** The host could not mint or consume a repository authorization. */
  "repository_authorization_failed": { fault: "bug", status: 500, retryAfter: 0 },
  /** An authorization that is spent, expired, or not this host's. */
  "repository_authorization_invalid": { fault: "user", status: 403, retryAfter: 0 },
  /** The host could not create the repository it was asked for. */
  "repository_creation_failed": { fault: "bug", status: 500, retryAfter: 0 },
  /** This repository was not opened with read access. */
  "repository_read_denied": { fault: "user", status: 403, retryAfter: 0 },
  /** This repository is open read-only, and the act would write. */
  "repository_read_only": { fault: "user", status: 403, retryAfter: 0 },
  /** That agent cannot launch on the harness it names. */
  "role_unlaunchable": { fault: "user", status: 400, retryAfter: 0 },
  /** No run with that id. */
  "run_not_found": { fault: "user", status: 404, retryAfter: 0 },
  /** No source with that id, or at that path, in the target graph. */
  "source_not_found": { fault: "user", status: 404, retryAfter: 0 },
  /** This build has no built SPA to serve: the app is missing its own front end. */
  "spa_missing": { fault: "bug", status: 503, retryAfter: 0 },
  /** A child process this host started did not start. */
  "spawn_failed": { fault: "dependency", status: 500, retryAfter: 0 },
  /** The target graph could not be built or revalidated, so the run has nothing to check itself against. */
  "target_graph_unavailable": { fault: "dependency", status: 503, retryAfter: 0 },
  /** No target with that label in the repository's graph. */
  "target_not_found": { fault: "user", status: 404, retryAfter: 0 },
  /** Every target run this host allows at once is in flight. */
  "target_run_capacity": { fault: "user", status: 429, retryAfter: 0 },
  /** The target is no longer declared by the repository: the grant was made against a graph that has moved. */
  "target_stale": { fault: "user", status: 409, retryAfter: 0 },
  /** That runId is already streaming; a second start would fork the same turn. */
  "turn_running": { fault: "user", status: 409, retryAfter: 0 },
  /** No harness with that id. */
  "unknown_harness": { fault: "user", status: 404, retryAfter: 0 },
  /** No agent with that id. */
  "unknown_role": { fault: "user", status: 404, retryAfter: 0 },
  /** A mutation whose body is not application/json. */
  "unsupported_media_type": { fault: "user", status: 415, retryAfter: 0 },
  /** A WebSocket route asked for over plain HTTP. */
  "upgrade_failed": { fault: "user", status: 400, retryAfter: 0 }
} satisfies Record<NativeRouteCode, NativeFailureEntry>

/**
 * The wire code for one of this host's route names.
 *
 * @since 1.0.0
 * @category constants
 */
export const nativeWireCode = (code: NativeRouteCode): NativeFailureCode => `${NATIVE_CODE_PREFIX}${code}`

/**
 * The one reviewed ingress for a native code that arrived as a string,
 * mirroring `workerFailureCode`. The BARE route name is not one: `not_found`
 * on the wire is plue's, and only the namespaced spelling is this host's.
 *
 * @since 1.0.0
 * @category constants
 */
export const nativeFailureCode = (value: unknown): NativeFailureCode | null => {
  if (typeof value !== "string" || !value.startsWith(NATIVE_CODE_PREFIX)) return null
  const route = value.slice(NATIVE_CODE_PREFIX.length)
  return Object.hasOwn(NATIVE_FAILURES, route) ? value as NativeFailureCode : null
}

/**
 * The registry row for a native code.
 *
 * @since 1.0.0
 * @category constants
 */
export const nativeFailureEntry = (code: NativeFailureCode): NativeFailureEntry =>
  NATIVE_FAILURES[code.slice(NATIVE_CODE_PREFIX.length) as NativeRouteCode]
