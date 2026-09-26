/**
 * The host's one Slack app: owner messages become `organization/intake`
 * runs, and approval gates parked under a Slack request are asked in its
 * thread with buttons.
 *
 * Admission is the source's, fail-closed: only the configured workspace,
 * and only the owners' direct messages or mentions in a listed channel;
 * echoes of this app are dropped. Each event is submitted under its
 * `slack:<team>:<event>` key, so Slack's redelivery joins the run it already
 * started. A press is answered only for the prompt it belongs to and only
 * from an owner (`Approval.decision`); anything else leaves the gate
 * pending. Which run a thread belongs to and which prompt a button belongs
 * to are kept in `slack.json` in the state directory, so both survive a
 * restart. An owner's message in a thread a one-on-one was opened in
 * (`meetings.ts` records them in `meetings.json`) starts
 * `organization/meetings-reply` for that meeting's role instead of a
 * delivery.
 */
import { Duration, Effect, Schedule } from "effect"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ExternalEvent } from "../../packages/smithers/agent/integrations/src/core/ExternalEvent.ts"
import * as Approval from "../../packages/smithers/agent/integrations/src/slack/Approval.ts"
import type * as Payload from "../../packages/smithers/agent/integrations/src/slack/Payload.ts"
import * as SlackClient from "../../packages/smithers/agent/integrations/src/slack/SlackClient.ts"
import * as SocketSource from "../../packages/smithers/agent/integrations/src/slack/SocketSource.ts"
import { type Control, operations } from "./client.ts"
import { meetingThread } from "./meetings.ts"
import type { Request } from "./schema.ts"
import * as TeamChannel from "./team-channel.ts"

/** What the host remembers about Slack between restarts. */
interface State {
  /** The intake run a Slack thread started. */
  readonly threads: Record<string, { readonly channel: string; readonly thread: string }>
  /** Approval prompts by button token. */
  readonly prompts: Record<string, {
    readonly runId: string
    readonly gateId: string
    readonly subjectDigest: string
    readonly channel: string
    readonly ts: string
    readonly settled?: boolean
  }>
}

const load = (file: string): State =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as State : { threads: {}, prompts: {} }

const save = (file: string, state: State) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

/** A Slack event key as a request key: `slack:<team>:<event id>`, with any other character replaced. */
export const requestKey = (dedupeKey: string): string =>
  dedupeKey.replaceAll(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128)

/** The request an admitted message or mention makes, or `undefined` for an event that asks nothing. */
export const requestOf = (event: ExternalEvent): Request | undefined => {
  if (event.eventName !== "integration:slack:message" && event.eventName !== "integration:slack:app_mention") {
    return undefined
  }
  const inner = (event.payload as { readonly event?: Record<string, unknown> }).event ?? {}
  const text = typeof inner["text"] === "string" ? inner["text"].replaceAll(/<@[A-Z0-9]+>/g, "").trim() : ""
  const channel = inner["channel"], user = inner["user"], ts = inner["ts"]
  if (text === "" || typeof channel !== "string" || typeof user !== "string" || typeof ts !== "string") return undefined
  // Message edits and deletions carry a subtype; they are not requests.
  if (inner["subtype"] !== undefined) return undefined
  const thread = typeof inner["thread_ts"] === "string" ? inner["thread_ts"] : ts
  return {
    key: requestKey(SocketSource.idempotencyKey(event)),
    text: text.slice(0, 8_000),
    source: "slack",
    user,
    conversation: { provider: "slack", channel, thread }
  }
}

/** Options for {@link run}. */
export interface Options {
  readonly control: Control
  readonly policy: Payload.Policy
  readonly stateDir: string
  readonly environment: Readonly<Record<string, string | undefined>>
  /** A fixture's plaintext socket. */
  readonly allowPlaintextSocket?: boolean | undefined
  /** How often parked gates are looked for. Default two seconds. */
  readonly pollEvery?: Duration.Input | undefined
  /** The team channel's wiki copy: the owner's messages there are recorded in it. */
  readonly team?: { readonly root: string; readonly teamDir: string } | undefined
}

/**
 * An owner's message in the team channel as the request it makes: the
 * thread's input, with the thread's recent posts beside it, recorded in the
 * channel's wiki copy. Any other message is returned as it is.
 */
export const teamRequest = (
  stateDir: string,
  team: { readonly root: string; readonly teamDir: string } | undefined,
  request: Request,
  at: number
): Request => {
  const channel = TeamChannel.channelId(stateDir)
  const conversation = request.conversation
  if (team === undefined || channel === undefined || conversation === undefined || conversation.channel !== channel) return request
  const thread = TeamChannel.threadOf(stateDir, channel, conversation.thread)
  TeamChannel.recordOwner(team, thread ?? `slack:${conversation.thread}`, request.text, at)
  if (thread === undefined) return request
  const posts = TeamChannel.recent(team, thread, 20)
  return { ...request, text: `${request.text}\n\nTeam thread ${thread}:\n${posts.join("\n")}`.slice(0, 8_000) }
}

/** Runs the Slack intake and the approval prompts until interrupted. */
export const run = (options: Options) =>
  Effect.gen(function*() {
    const file = join(options.stateDir, "slack.json")
    let state = load(file)
    const update = (change: (state: State) => State) => {
      state = change(state)
      save(file, state)
    }
    const ops = operations(options.control)
    const client = SlackClient.make({}, options.environment)
    const owners = options.policy.allowedUserIds ?? []
    const call = (method: string, params: Readonly<Record<string, unknown>>) => client.call(method, params)

    const onEvent = (event: ExternalEvent) =>
      Effect.gen(function*() {
        if (event.eventName === "integration:slack:block_actions") return yield* onPress(event.payload)
        const request = requestOf(event)
        if (request === undefined) return
        // An owner's message in a one-on-one's thread is answered by its role, not delivered.
        const meeting = request.conversation === undefined
          ? undefined
          : meetingThread(options.stateDir, request.conversation.channel, request.conversation.thread)
        if (meeting !== undefined && request.conversation !== undefined) {
          if (request.user === undefined || !owners.includes(request.user)) return
          const replied = yield* Effect.tryPromise(() =>
            ops.start("organization/meetings-reply", {
              key: request.key,
              principal: meeting.principal,
              channel: request.conversation!.channel,
              thread: request.conversation!.thread,
              text: request.text
            }, request.key)
          )
          yield* Effect.logInfo("organization meeting reply", { runId: replied.runId, joined: replied.joined })
          return
        }
        const started = yield* Effect.tryPromise(() => ops.submit(teamRequest(options.stateDir, options.team, request, Date.now())))
        update((current) => ({ ...current, threads: { ...current.threads, [started.runId]: request.conversation! } }))
        yield* Effect.logInfo("organization intake", { runId: started.runId, joined: started.joined })
      })

    const onPress = (payload: unknown) =>
      Effect.gen(function*() {
        const token = Approval.pressedToken(payload)
        const prompt = token === null ? undefined : state.prompts[token]
        if (token === null || prompt === undefined || prompt.settled === true) return
        const outcome = Approval.decision(payload, { mode: "approve", token, allowedUserIds: owners })
        if (outcome._tag !== "Decided") return
        const decision = outcome.decision
        yield* Effect.tryPromise(() =>
          ops.answer({ gateId: prompt.gateId, runId: prompt.runId, approved: decision.approved, reason: `decided in Slack by ${decision.decidedBy}` })
        )
        update((current) => ({ ...current, prompts: { ...current.prompts, [token]: { ...prompt, settled: true } } }))
        yield* call("chat.update", {
          channel: prompt.channel,
          ts: prompt.ts,
          text: `${decision.approved ? "Approved" : "Declined"} by <@${decision.decidedBy}>: ${prompt.gateId}.`,
          blocks: []
        })
      })

    // Asks each gate parked under a Slack thread once, in that thread.
    const promptGates = Effect.gen(function*() {
      const gates = yield* Effect.tryPromise(() => ops.gates())
      for (const gate of gates) {
        const thread = state.threads[gate.runId]
        if (thread === undefined) continue
        const token = Approval.token(`${gate.runId}/${gate.gateId}/${gate.subjectDigest}`)
        if (state.prompts[token] !== undefined) continue
        const posted = yield* call("chat.postMessage", {
          channel: thread.channel,
          thread_ts: thread.thread,
          text: gate.prompt.slice(0, 3_000),
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: gate.prompt.slice(0, 2_900) } },
            ...Approval.blocks({ mode: "approve", token, allowedUserIds: owners })
          ]
        })
        update((current) => ({
          ...current,
          prompts: {
            ...current.prompts,
            [token]: {
              runId: gate.runId,
              gateId: gate.gateId,
              subjectDigest: gate.subjectDigest,
              channel: thread.channel,
              ts: String(posted["ts"])
            }
          }
        }))
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("organization gate prompts", cause)))

    const source = SocketSource.make({
      policy: options.policy,
      ...(options.allowPlaintextSocket === true ? { allowPlaintextSocket: true } : {})
    }, options.environment)
    yield* Effect.forkScoped(promptGates.pipe(Effect.repeat(Schedule.spaced(options.pollEvery ?? Duration.seconds(2)))))
    // A refused or failed request is logged and acknowledged: its key already
    // deduplicates a retry, and an unacknowledged event would end the source.
    yield* source.run((events) =>
      Effect.forEach(events, (event) =>
        onEvent(event).pipe(
          Effect.catchCause((cause) => Effect.logWarning("organization Slack event not handled", cause))
        ), { discard: true })
    )
  })
