/**
 * Approvals: a consequential flow call waits for the person at the keyboard.
 *
 * The kernel's attended `GrantStore` is the whole model. `authorize` asks it
 * for each consequential capability a call declares, `Agent.Options.authorize`
 * runs that before the call's clock starts, and a denial reaches the cell as
 * `capability_refused` carrying the `Denied: ` message this module writes. The
 * UI polls `list` and answers with `reply`.
 *
 * Consequential means the declared capability can change something the
 * workspace's VCS will not show, or reach outside the process: every
 * `fs:write` (this host restores no snapshot, so "compensable" is never
 * compensated), `proc:spawn`, and all `net:` actions (a GET still sends data
 * out). Reads and the TUI's own runtime flows declare none of these, except
 * `monitor.create`, whose shell source runs a command.
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import type * as Cell from "@smthrs/harness/Cell"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Layer, Option } from "effect"
import { lstatSync, readlinkSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import * as Changes from "./changes.ts"
import type * as Monitors from "./monitors.ts"

/** `ask` waits for y/n, `all` asks nothing, `deny` refuses every consequential call. */
export type Mode = "ask" | "all" | "deny"
/** The answers `GrantStore.reply` takes that the TUI offers. */
export type Choice = "once" | "deny" | "run"

export interface Meta {
  readonly flow: string
  readonly subject: string
  /** `chat`, or the worker tab id. */
  readonly source: string
}

export interface Request {
  readonly capability: Capability.Capability
  readonly meta: Meta
}

export interface Pending extends Meta {
  readonly requestId: string
  readonly action: Capability.Action
  readonly tier: Capability.EffectTier
  /** Whether the store can grant this for the rest of the session. */
  readonly always: boolean
}

export const environmentKey = "SMITHERS_TUI_APPROVE"

/**
 * Every call runs unasked by default. `--approve` (winning) or
 * `SMITHERS_TUI_APPROVE` set to `ask` or `deny` turns the gate on.
 */
export const mode = (
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly print: boolean; readonly flag?: string | undefined }
): Mode | { readonly error: string } => {
  const [value, name, joiner] = options.flag !== undefined
    ? [options.flag, "--approve", " "]
    : [env[environmentKey], environmentKey, "="]
  if (value === undefined || value === "") return "all"
  if (value !== "ask" && value !== "all" && value !== "deny") {
    return { error: `${name} must be ask, all or deny` }
  }
  if (value === "ask" && options.print) return { error: `${name}${joiner}ask needs the interactive TUI` }
  return value
}

export const consequential = (capability: Capability.Capability, cwd: string): boolean =>
  capability.action.startsWith("net:") || Capability.tierOf(capability, { workspaceRoot: cwd }) !== "sealed"

/**
 * A path as the write will reach it: every symlink on the way is followed,
 * including a dangling last one, which a write creates the target of.
 * Components that do not exist yet are kept as written.
 */
export const real = (path: string): string => {
  let head = "/"
  const rest = (isAbsolute(path) ? path : `${process.cwd()}/${path}`).split("/")
  let hops = 0
  while (rest.length > 0) {
    const part = rest.shift()!
    if (part === "" || part === ".") continue
    if (part === "..") {
      head = dirname(head)
      continue
    }
    const next = join(head, part)
    let link: string | undefined
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next)
    } catch {
      // Absent components retain their names.
    }
    if (link === undefined) head = next
    else {
      if (++hops > 64) throw new HarnessError({ code: "engine_failed", message: "Too many symlinks" })
      if (isAbsolute(link)) head = "/"
      rest.unshift(...link.split("/"))
    }
  }
  return head
}

/** Keys that never change what a call does, per flow. */
const inert: Record<string, ReadonlyArray<string>> = { bash: ["mode", "timeoutMs"] }

/**
 * What a row shows for a call: its lone string input as itself, otherwise the
 * whole raw input. Never a chosen key, since the flow's decoder may strip that
 * key while another one runs.
 */
export const shownInput = (flow: string, input: unknown): string => {
  if (typeof input !== "object" || input === null) return input === undefined ? "" : JSON.stringify(input)
  const keys = Object.keys(input).filter((key) => !(inert[flow] ?? []).includes(key))
  const only = keys.length === 1 ? (input as Record<string, unknown>)[keys[0]!] : undefined
  return typeof only === "string" ? only : JSON.stringify(input)
}

/**
 * Flows that spawn a process for some inputs only: the command a call runs,
 * or `undefined` when it runs none. A shell-sourced monitor runs its command
 * on every tick, so creating one is asked like running it.
 */
const spawns: Readonly<Record<string, (input: unknown) => string | undefined>> = {
  "monitor.create": (input) => {
    const source = typeof input === "object" && input !== null ? (input as { source?: unknown }).source : undefined
    if (typeof source !== "object" || source === null) return undefined
    const { kind, command } = source as { kind?: unknown; command?: unknown }
    return kind === "shell" ? String(command) : undefined
  }
}

/**
 * The request a restored shell monitor waits on before it runs again: the one
 * `monitor.create` asked, so an `a` for that flow covers both.
 */
export const monitorRequest = (command: string, source = "chat"): Request => ({
  capability: Capability.make("proc:spawn", "monitor.create"),
  meta: { flow: "monitor.create", subject: command, source }
})

/**
 * `Monitors.Ports.authorize` over a host's `authorize`: a restored shell
 * monitor asks under this session's mode, whatever the session that created
 * it allowed. Other sources run nothing and ask nothing.
 */
export const restored =
  (authorize: (requests: ReadonlyArray<Request>) => Promise<void>) =>
  (monitor: Pick<Monitors.Monitor, "source">): Promise<void> =>
    authorize(monitor.source.kind === "shell" ? [monitorRequest(monitor.source.command)] : [])

/** One request per consequential capability, narrowed to what this call touches. */
export const requests = (call: Cell.Call, cwd: string, source: string): ReadonlyArray<Request> => {
  const found = new Map<string, Request>()
  const subject = shownInput(call.flowName, call.input)
  const add = (capability: Capability.Capability, shown: string) =>
    found.set(Capability.format(capability), { capability, meta: { flow: call.flowName, subject: shown, source } })
  for (const declared of call.capabilities) {
    const parsed = Capability.parse(declared)
    if (Option.isNone(parsed) || !consequential(parsed.value, cwd)) continue
    const capability = parsed.value
    if (capability.action === "fs:write") {
      // `undefined` or nothing named: ask for everything the flow declares.
      const paths = Changes.touched(call.flowName, call.input) ?? []
      if (paths.length === 0) add(capability, subject)
      const root = real(cwd)
      for (const path of paths) {
        // The store classifies lexically, so hand it the path the write reaches.
        const target = real(isAbsolute(path) ? path : `${cwd}/${path}`)
        const inside = relative(root, target)
        add(
          Capability.make("fs:write", target),
          inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : target
        )
      }
    } else if (capability.action === "proc:spawn") {
      // The flow, not the command: `a` then means this flow for the session.
      const spawned = spawns[call.flowName]
      const shown = spawned === undefined ? subject : spawned(call.input)
      if (shown === undefined) continue
      add(Capability.make("proc:spawn", call.flowName), shown)
    } else {
      add(capability, subject)
    }
  }
  return [...found.values()]
}

/** A project plan grants its declared envelope, not a built-in writer's input shape. */
export const project = (
  flow: string,
  capabilities: ReadonlyArray<string>,
  cwd: string,
  source: string
): ReadonlyArray<Request> => {
  const found = new Map<string, Request>()
  for (const declared of capabilities) {
    const parsed = Capability.parsePattern(declared)
    if (Option.isNone(parsed)) {
      throw new HarnessError({ code: "engine_failed", message: `Invalid capability: ${declared}` })
    }
    const pattern = parsed.value
    for (const action of Capability.Action.literals) {
      if (pattern.action !== "*" && pattern.action !== action && pattern.action !== `${action.split(":")[0]}:*`) {
        continue
      }
      // A glob cannot prove symlink containment. Ask for broad write authority.
      const resource = action === "fs:write"
        ? Capability.isLiteralResource(pattern.resource)
          ? real(isAbsolute(pattern.resource) ? pattern.resource : `${cwd}/${pattern.resource}`)
          : "/**"
        : action === "proc:spawn"
        ? flow
        : pattern.resource
      const capability = Capability.make(action, resource)
      if (!consequential(capability, cwd)) continue
      const subject = Capability.format(capability)
      found.set(subject, { capability, meta: { flow, subject, source } })
    }
  }
  return [...found.values()]
}

const denyAll = new Permission.Rule({
  effect: "deny",
  pattern: new Capability.CapabilityPattern({ action: "*", resource: "**" })
})

export const layer = (cwd: string, approvals: Mode): Layer.Layer<GrantStore.GrantStore> =>
  GrantStore.layer({ attended: true, planDigest: "smithers-tui", rules: approvals === "deny" ? [denyAll] : [] }).pipe(
    // Real, like the resources `requests` asks for, so containment agrees.
    Layer.provide(Workspace.layer(real(cwd))),
    Layer.orDie
  )

/** Starts every denial message this host writes; the cell reads it as `capability_refused`. */
export const deniedPrefix = "Denied: "

/** Whether a settled call is a denial this host wrote, not some other refusal. */
export const denied = (result: Cell.CallResult): boolean =>
  result.outcome === "failure" && result.code === "capability_refused" &&
  (result.message ?? "").startsWith(deniedPrefix)

/** Print mode's notice for a denied flow: one line per flow, the first time only. */
export const notices = () => {
  const seen = new Set<string>()
  return (flow: string): string | undefined => {
    if (seen.has(flow)) return undefined
    seen.add(flow)
    return `denied ${flow}; ${environmentKey}=all allows`
  }
}

/** `Agent.Options.authorize`: waits for every consequential request, in order. */
export const authorize =
  (grants: GrantStore.Service, options: { readonly cwd: string; readonly source: string }) =>
  (call: Cell.Call): Effect.Effect<void, HarnessError> => check(grants, requests(call, options.cwd, options.source))

/** Both worker calls and project launches wait on this same store. */
export const check = (
  grants: GrantStore.Service,
  requests: ReadonlyArray<Request>
): Effect.Effect<void, HarnessError> =>
  Effect.forEach(
    requests,
    (request) =>
      grants.check(request.capability, { ...request.meta }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Permission.PermissionDenied
            ? new HarnessError({
              code: "engine_failed",
              message: `${deniedPrefix}${request.meta.flow} ${request.meta.subject}`,
              cause
            })
            : new HarnessError({ code: "engine_failed", message: "Approval store failed", cause })
        )
      ),
    { discard: true }
  )

const order = (requestId: string): number => Number(requestId.slice(requestId.lastIndexOf("-") + 1))

/** The store's waiting requests, oldest first. */
export const pending = (list: ReadonlyArray<GrantStore.PendingRequest>): ReadonlyArray<Pending> =>
  [...list].sort((a, b) => order(a.requestId) - order(b.requestId)).map((request) => ({
    requestId: request.requestId,
    flow: String(request.meta.flow ?? ""),
    subject: String(request.meta.subject ?? ""),
    source: String(request.meta.source ?? "chat"),
    action: request.capability.action,
    tier: request.tier,
    always: request.capability.action === "fs:write"
      ? request.tier === "compensable"
      : Option.isSome(Capability.patternFromCapability(request.capability))
  }))

export const reply = (
  grants: GrantStore.Service,
  request: Pending,
  choice: Choice,
  cwd: string
): Effect.Effect<void, Permission.GrantStoreError> =>
  grants.reply(
    request.requestId,
    choice,
    choice === "run" && request.action === "fs:write"
      ? new Capability.CapabilityPattern({ action: "fs:write", resource: `${real(cwd).replace(/\/+$/, "")}/**` })
      : undefined
  )

/** `reply`, settled: the store's error code when it refused the answer, else `undefined`. */
export const answer = (
  grants: GrantStore.Service,
  request: Pending,
  choice: Choice,
  cwd: string
): Effect.Effect<Permission.GrantStoreError["code"] | undefined> =>
  reply(grants, request, choice, cwd).pipe(
    Effect.match({ onFailure: (error) => error.code, onSuccess: () => undefined })
  )

/** What `a` grants for the rest of the session. */
export const scope = (request: Pending): string => request.action === "fs:write" ? "all edits" : `all ${request.flow}`

/**
 * How long a row is on screen before y, n or a answers it. Rows arrive on a
 * poll, so without this a person typing "add tests" as one appeared would
 * grant the session with the `a`.
 */
export const armMs = 400

/** How often the UI reads the store while work runs; well under `armMs`, far above the 100 ms clock. */
export const pollMs = 250

/**
 * Calls `read` now and every `ms` until stopped, never while the last call is
 * still in flight: a slow store is not asked again before it answers.
 */
export const poll = (read: () => Promise<unknown>, ms = pollMs): () => void => {
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    read().then(() => {
      busy = false
    }, () => {
      busy = false
    })
  }
  tick()
  const timer = setInterval(tick, ms)
  return () => clearInterval(timer)
}

/**
 * Whether the front row takes keys yet.
 *
 * `requestId` is the row whose delay runs since `since`. `waiting` is the
 * request last answered while the store still lists it: nothing arms until a
 * poll shows it gone, so a double-tapped `y` never answers the next row.
 */
export interface Arming {
  readonly requestId: string | undefined
  readonly since: number
  readonly waiting: string | undefined
}

export const idle: Arming = { requestId: undefined, since: 0, waiting: undefined }

/**
 * After each poll. `listed` is everything the store holds; `skip` is what the
 * UI already answered and so does not show. The front row's delay starts the
 * first poll it is shown on.
 */
export const shown = (
  arming: Arming,
  listed: ReadonlyArray<Pending>,
  now: number,
  skip: ReadonlySet<string> = new Set()
): Arming => {
  if (arming.waiting !== undefined && listed.some((request) => request.requestId === arming.waiting)) return arming
  const front = listed.find((request) => !skip.has(request.requestId))?.requestId
  if (front === undefined) return idle
  if (front === arming.requestId && arming.waiting === undefined) return arming
  return { requestId: front, since: now, waiting: undefined }
}

/**
 * The editor changed: sending, clearing or typing restarts the front row's
 * delay, so the first letters of the next message are never an answer.
 */
export const edited = (arming: Arming, now: number): Arming =>
  arming.requestId === undefined || arming.waiting !== undefined ? arming : { ...arming, since: now }

/** A key answered `requestId`; the next row waits for a poll without it. */
export const answered = (requestId: string): Arming => ({ requestId: undefined, since: 0, waiting: requestId })

/** The store refused the answer to `requestId`; its row shows and arms again. */
export const failed = (arming: Arming, requestId: string): Arming => arming.waiting === requestId ? idle : arming

export const armed = (arming: Arming, front: string | undefined, now: number): boolean =>
  front !== undefined && arming.waiting === undefined && arming.requestId === front && now - arming.since >= armMs

/** Whether the front row shows its keys: exactly when `key` would take one. */
export const ready = (arming: Arming, front: string | undefined, now: number, draft: string): boolean =>
  draft === "" && armed(arming, front, now)

/** The answer a key gives, or `undefined` so the key reaches the editor. */
export const key = (
  name: string,
  state: {
    readonly draft: string
    readonly shift: boolean
    readonly ctrl: boolean
    readonly meta: boolean
    /** See `armed`. */
    readonly armed: boolean
    readonly pending: ReadonlyArray<Pending>
    /** Keys the focused panel acts on; they reach the panel, never an approval. */
    readonly reserved?: ReadonlyArray<string>
  }
): Choice | undefined => {
  const first = state.pending[0]
  if (first === undefined || !state.armed || state.draft !== "" || state.shift || state.ctrl || state.meta) {
    return undefined
  }
  if (state.reserved?.includes(name) === true) return undefined
  if (name === "y") return "once"
  if (name === "n") return "deny"
  if (name === "a" && first.always) return "run"
  return undefined
}
