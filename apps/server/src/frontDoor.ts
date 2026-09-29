import * as Effect from "effect/Effect"
import { AGENT_TURN_FRONT_DOOR_CALL_PREFIX } from "@smthrs/rpc/NativeAgent"
import type { AgentChatMessage, AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { routeRefusal } from "./Responses"
import type { TurnRequest } from "./cloudRoleTurn"
import { modelRefusal, planDecisionModel } from "./configuredModel"
import { ServerConfig } from "./Config"
import type { Transport } from "./Http"
import { JEV_DEFAULT_MODEL, jevEvaluate } from "./jev"
import type { JevAnswer, JevAnswerValue, JevQuestion } from "./jev"
/**
 * The front door: Jev decides the turn before the concierge is paid for it.
 *
 * "The decision model Jev is the main model and it just happens to decide we
 * should utilize an llm sometimes." Every chat message now reaches Jev first.
 * When the message IS, with high confidence, one of the commands this client
 * can run right now, this Worker answers the turn itself with the same frames
 * the concierge would have emitted for that command — so the browser's own
 * execution boundary opens the command's form or runs it — and no chat turn
 * is spent. Below the floor, or on `none`, the turn goes upstream to the
 * concierge: that is Jev deciding, and the concierge is what it decided on.
 *
 * A Jev that FAILS is not that. There is no fallback: an unset
 * `AI_GATEWAY_API_KEY`, a refused gateway, a missed deadline or an answer
 * this client cannot read refuses the turn with the same typed failures a
 * cloud role turn uses for an unavailable model (cloudRoleTurn.ts), and the
 * chat upstream is never spent instead. The main model being down is an
 * outage the client is told about, not a silent downgrade to an LLM.
 *
 * Three things make the routing honest rather than clever.
 *
 * The catalog is DATA. The offered commands ride the turn body
 * (`StartAgentTurnRequest.commands`, the same `{ name, summary }` list the
 * recommender posts), never parsed back out of the system prompt. Its size
 * never decides anything: a catalog longer than one choice question holds is
 * split across the questions of ONE request, under the boolean gate that
 * holds those questions together (`askFrontDoor`).
 *
 * The frames are the CLIENT's own contract, not a new one. A routed turn is
 * one `tool_call` frame naming the one tool the model has (`commands`) with
 * `{"action":"execute","name":"<command>"}` and NO args, then `done` with
 * reason `tool_call`. The client already handles exactly that
 * (apps/app controller/turns.ts subscribeToAgent, HttpTurn.ts
 * projectHttpFrame): it executes the call through the registry — which
 * renders the flow's form when a required argument is missing, and runs the
 * command when none is — and then POSTs a continuation leg carrying the
 * function_call / function_call_output pair.
 *
 * That continuation is the one place the protocol forces a choice: the client
 * MUST post it. So the call id this module mints is prefixed (`frontdoor-`,
 * spelled in @smthrs/rpc NativeAgent so both halves read one constant), the
 * prefix round-trips through the client untouched, and a continuation whose
 * trailing call carries it is answered here too — with `done` and nothing
 * else. The answer is the act: the client records the registry's own honest
 * result line ("Smithers ran /runs.list", or the refusal it really got) as
 * this turn's assistant words, so the transcript keeps one line that is both
 * what the user reads and what every later turn's model reads. No claim about
 * run state is invented, and the deterministic claim surface (RunClaims.ts)
 * still owns a launch turn's prose. A client that forges the prefix buys
 * itself a turn that says nothing, no model call and no ceiling it had not
 * already spent.
 *
 * Privacy: the tail already goes to Jev for the composer's pills under zero
 * data retention, and it rides the same way here. The turn's hidden runtime
 * `context` does NOT: only the active repository's name, validated as
 * "owner/name", leaves with the conversation tail.
 */
import {
  jevCommandChunks,
  RECOMMEND_JEV_COMMANDS_MAX,
  RECOMMEND_JEV_TIMEOUT_MS,
  jevFailureDetail,
  jevFailureMessage,
  RECOMMEND_REPO_PATTERN,
  RECOMMEND_TAIL_MAX_CHARS,
  RECOMMEND_TAIL_MAX_ENTRIES,
  RecommendLogStore,
  recommendQuestionKey,
  tailText
} from "./recommend"
import type { RecommendCommand, RecommendTailMessage } from "./recommend"
import { sha256Hex } from "./turnLimit"

/**
 * How sure Jev must be before this Worker answers the turn itself.
 *
 * TypeSafe reports 76% agreement between Jev and frontier-model reference
 * labels on its own published evals, so roughly one decision in four is
 * arguable even on the vendor's home ground. Routing a turn is not arguable:
 * it replaces the concierge's answer with an act. The floor is therefore set
 * well above the point where the model is merely leaning. A wrong route runs
 * a command the user did not ask for, while a missed route costs one ordinary
 * chat turn, which is what every turn cost yesterday.
 */
export const FRONT_DOOR_CONFIDENCE_FLOOR = 0.85

/**
 * How sure Jev must be that the message asks for a command AT ALL before one
 * of the split catalog's questions may route it.
 *
 * A question only ever sees its own slice of the catalog, so it answers "the
 * best of these 254, or none of them" — and the slice holding the right
 * command cannot know the other slices said `none` for a good reason. The
 * boolean question reads the whole message instead of a slice of the catalog,
 * so it is the one answer that can say the message is not a command at all.
 * It only ever REMOVES a route, so it is held to the same bar as the command
 * itself.
 */
export const FRONT_DOOR_IS_COMMAND_FLOOR = 0.85

/** The option that means "this is not a request to run a command". */
export const FRONT_DOOR_NONE = "none"

/**
 * The most commands ONE front-door choice question offers: a choice question
 * holds RECOMMEND_JEV_COMMANDS_MAX options and `none` rides beside the
 * commands in every one of them.
 */
export const FRONT_DOOR_JEV_COMMANDS_MAX = RECOMMEND_JEV_COMMANDS_MAX - 1

/** The key of the one command question a catalog that fits one question asks under. */
export const FRONT_DOOR_COMMAND_KEY = "command"

/** The key of the boolean question that gates a split catalog's answers. */
export const FRONT_DOOR_IS_COMMAND_KEY = "isCommand"

/**
 * The prefix on a call id this Worker minted. It round-trips through the
 * client's tool loop, so the continuation leg is recognisable without any
 * server-side state — and the client reads the same prefix to know that
 * leg's act is the turn's answer. Spelled once in the contract package both
 * halves share.
 */
export const FRONT_DOOR_CALL_PREFIX = AGENT_TURN_FRONT_DOOR_CALL_PREFIX

/** The one tool the chat model has (apps/app flows/agentTools.ts commandsToolSpec). */
export const FRONT_DOOR_TOOL = "commands"

/**
 * What Jev decides about the message, in the words the question offers.
 *
 * The decision is about `message` — the one the user just sent — and nothing
 * else. `conversation` is there to disambiguate it, never to be decided
 * about: reading the tail as one blob routed a plain question ("In one
 * sentence, what is a durable flow?") to the command an EARLIER, unanswered
 * message had asked for, and kept routing it turn after turn.
 */
export const FRONT_DOOR_CHOICE_INSTRUCTIONS =
  "The user just sent `message` to Smithers, a product where a coding agent works on a repository. " +
  "Choose the command `message` asks the app to run, or `none` when it asks for no command at all. " +
  "Decide about `message` alone: `conversation` is the earlier conversation, given only to make `message` clear, " +
  "and a request in it is not a request now. " +
  "Choose a command only when running it is plainly what `message` wants; a question about a command is not a request to run it."

/** What `none` means in every command question: the option the concierge is behind. */
export const FRONT_DOOR_NONE_CRITERION =
  "the message is not a request to run one of these commands: it is a question, a discussion, a coding task, or small talk"

/**
 * The question a split catalog is gated on. Each command question sees only
 * its own slice, so none of them can say the message asks for no command at
 * all; this one reads the message itself and answers exactly that.
 */
export const FRONT_DOOR_IS_COMMAND_INSTRUCTIONS =
  "Is the message a request to run a command on this product, rather than a question, a discussion, a coding task, or small talk?"

/**
 * The offered catalog as choice questions, all carried by ONE request: at most
 * FRONT_DOOR_JEV_COMMANDS_MAX commands each, plus that question's own `none`.
 *
 * A catalog that fits one question asks it under the single `command` key it
 * has always used, so the live path (today's client offers 194 commands) sends
 * the same bytes it sent before a longer catalog was possible. A longer one is
 * split, keyed `command1`, `command2`, … exactly as the recommender keys its
 * own split (`recommendQuestionKey`), and the gateway answers the questions of
 * one request in parallel, so the split costs no extra latency.
 */
export const frontDoorCommandQuestions = (
  commands: ReadonlyArray<RecommendCommand>
): Readonly<Record<string, JevQuestion>> => {
  const chunks = jevCommandChunks(commands, FRONT_DOOR_JEV_COMMANDS_MAX)
  return Object.fromEntries(chunks.map((chunk, index) => [
    chunks.length === 1 ? FRONT_DOOR_COMMAND_KEY : recommendQuestionKey(index),
    {
      type: "choice",
      instructions: FRONT_DOOR_CHOICE_INSTRUCTIONS,
      criteria: {
        ...Object.fromEntries(chunk.map((command) => [command.name, command.summary])),
        [FRONT_DOOR_NONE]: FRONT_DOOR_NONE_CRITERION
      }
    } satisfies JevQuestion
  ]))
}

/**
 * The impossible-act classes, in the same words the client's own detector
 * uses (apps/app state/RunClaims.ts ASK_PATTERNS). This slice only LOGS the
 * answer: the client's regexes still decide, and nothing here acts on it.
 */
export const FRONT_DOOR_IMPOSSIBLE_CRITERIA: Readonly<Record<string, string>> = {
  none: "the message asks for none of the acts below",
  email: "the message asks for an email to be sent, drafted or composed",
  "local-files": "the message asks for files on the user's own laptop, machine or local file system to be read or opened",
  messaging: "the message asks for something to be posted or sent to Slack, WhatsApp, SMS, Discord or Microsoft Teams",
  push: "the message asks for commits to be pushed to a branch, to main, or to a GitHub repository",
  pr: "the message asks for a pull request to be opened, created, filed or raised, or for a link to one"
}

/** What one front-door read decided, as the log records it and the route acts on it. */
export interface FrontDoorDecision {
  /**
   * The command Jev chose, or undefined when it chose `none`, named nothing
   * offered, or — over a split catalog — two questions each named one.
   */
  readonly command: string | undefined
  /** Jev's probability for that choice; 0 when the answer carried no probabilities. */
  readonly confidence: number
  /**
   * Jev's probability that the message asks for a command at all. It is 1
   * when the catalog fit one question and the boolean was never asked, so the
   * gate cannot change a decision the split never touched.
   */
  readonly isCommand: number
  /** The impossible-act class, logged only. */
  readonly impossible: string
}

/**
 * Jev's probability that the message is a request to run a command.
 * `undefined` is an answer this client cannot read, which is Jev failing; 1
 * is the gate not being asked, because a catalog that fits ONE question needs
 * nothing to hold its questions together.
 */
const isCommandProbability = (
  answers: Readonly<Record<string, JevAnswerValue>>,
  asked: boolean
): number | undefined => {
  if (!asked) return 1
  const gate = answers[FRONT_DOOR_IS_COMMAND_KEY]
  if (gate?.type !== "boolean" || typeof gate.probability !== "number" || !Number.isFinite(gate.probability)) {
    return undefined
  }
  return gate.probability
}

const isPlainMessage = (
  message: AgentChatMessage
): message is { readonly role: "user" | "assistant"; readonly content: string } =>
  "role" in message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string"

/**
 * Whether this turn is one the front door may read: a plain conversation turn
 * whose last message is the user's own. A transcript carrying a
 * function_call or function_call_output item is a tool-loop continuation —
 * the model is mid-act, and a decision model has no business restarting it.
 */
export const isFrontDoorTurn = (body: TurnRequest): boolean => {
  if (!body.messages.every(isPlainMessage)) return false
  const last = body.messages[body.messages.length - 1]
  return last !== undefined && isPlainMessage(last) && last.role === "user" && last.content.trim() !== ""
}

/**
 * The conversation Jev reads, bounded exactly as the recommender bounds it:
 * the newest messages, at most RECOMMEND_TAIL_MAX_ENTRIES of them and
 * RECOMMEND_TAIL_MAX_CHARS of text, oldest dropped first.
 */
export const frontDoorTail = (body: TurnRequest): ReadonlyArray<RecommendTailMessage> => {
  const entries = body.messages
    .filter(isPlainMessage)
    .filter((message) => message.content.trim() !== "")
    .slice(-RECOMMEND_TAIL_MAX_ENTRIES)
    .map((message): RecommendTailMessage => ({ role: message.role, text: message.content.trim() }))
  const total = (rows: ReadonlyArray<RecommendTailMessage>): number => rows.reduce((sum, row) => sum + row.text.length, 0)
  let tail = entries
  while (tail.length > 1 && total(tail) > RECOMMEND_TAIL_MAX_CHARS) tail = tail.slice(1)
  const only = tail[0]
  if (tail.length === 1 && only !== undefined && only.text.length > RECOMMEND_TAIL_MAX_CHARS) {
    tail = [{ role: only.role, text: only.text.slice(-RECOMMEND_TAIL_MAX_CHARS) }]
  }
  return tail
}

/**
 * The one field of the hidden runtime context that leaves for Jev: the active
 * repository's name, and only when it really is one. Everything else the
 * context carries — tabs, world notes, setups, the login — stays here.
 */
export const frontDoorRepo = (body: TurnRequest): string | null => {
  const active = body.context?.activeRepository
  return typeof active === "string" && RECOMMEND_REPO_PATTERN.test(active) ? active : null
}

/**
 * What one front-door read came back as.
 *
 * `skipped` is the only reading that spends the chat upstream without a
 * decision, and it never means Jev failed: there was nothing for Jev to
 * choose among. Catalog size is not one of those reasons — a catalog of any
 * size is split across the questions of one request (see
 * `frontDoorCommandQuestions`).
 */
export type FrontDoorRead =
  /** Jev answered: route the turn, or hand it to the concierge. */
  | { readonly kind: "decided"; readonly decision: FrontDoorDecision }
  /** Not a turn Jev is asked about at all. */
  | { readonly kind: "skipped" }
  /** This deployment has no `AI_GATEWAY_API_KEY`. */
  | { readonly kind: "unconfigured" }
  /** Jev was asked and did not answer. The turn is refused, never re-routed. */
  | { readonly kind: "failed"; readonly failure: Exclude<JevAnswer, { readonly ok: true }> }

/**
 * One Jev read over the offered commands, whatever the catalog's size.
 *
 * The commands ride ONE request as one choice question, or as several when
 * the catalog is longer than one question holds, plus the boolean gate that
 * reads the message rather than a slice of the catalog. Probabilities from
 * different questions are never compared, because they are not comparable:
 * each is measured against that question's own options. So a split answer
 * decides a command only when EXACTLY ONE question named an offered command
 * and every other question named none. Two questions both naming one is
 * ambiguity, not a decision — the concierge answers that turn, as it answers
 * every turn Jev does not route.
 */
export const askFrontDoor = (
  body: TurnRequest,
  commands: ReadonlyArray<RecommendCommand>,
  model: string = JEV_DEFAULT_MODEL
): Effect.Effect<FrontDoorRead, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    if (config.aiGatewayApiKey === undefined) return { kind: "unconfigured" } as const
    if (commands.length === 0) return { kind: "skipped" } as const
    /*
     * The turn's own message is the decision; the rest of the tail is context
     * under its own key. `isFrontDoorTurn` has already held the last message
     * to be the user's own non-empty text, so it is the last tail entry.
     */
    const tail = frontDoorTail(body)
    const message = tail[tail.length - 1]
    if (message === undefined) return { kind: "skipped" } as const
    const earlier = tail.slice(0, -1)
    const questions = frontDoorCommandQuestions(commands)
    const keys = Object.keys(questions)
    const split = keys.length > 1
    const answer = yield* jevEvaluate({
      model,
      state: {
        repository: frontDoorRepo(body) ?? "(none selected)",
        conversation: earlier.length === 0 ? "(no earlier messages)" : tailText(earlier),
        message: message.text
      },
      questions: {
        ...questions,
        // One question sees the whole catalog and needs no gate, so a catalog
        // that fits one asks exactly what it asked before the split existed.
        ...(split ? { [FRONT_DOOR_IS_COMMAND_KEY]: { type: "boolean", instructions: FRONT_DOOR_IS_COMMAND_INSTRUCTIONS } } : {}),
        impossible: {
          type: "choice",
          instructions:
            "Which act that Smithers cannot perform does this message ask for? Answer `none` unless the message plainly asks for one of them.",
          criteria: FRONT_DOOR_IMPOSSIBLE_CRITERIA
        }
      }
    }, RECOMMEND_JEV_TIMEOUT_MS)
    if (!answer.ok) return { kind: "failed", failure: answer } as const
    const offered = new Set(commands.map((command) => command.name))
    /*
     * One reading per command question: the command it named, and the chosen
     * option's own probability. A choice the question never offered is not a
     * decision, and neither is `none`. An answer that carries no
     * probabilities says only WHICH option won, never by how much, so it can
     * never clear the floor: the turn goes to the concierge rather than being
     * routed on an unmeasured lean.
     */
    const reads: Array<{ readonly command: string | undefined; readonly confidence: number }> = []
    for (const key of keys) {
      const choice = answer.answers[key]
      // A 200 whose command answer this client cannot read is Jev failing,
      // and it reads as the same empty answer the client reports for a 200
      // that carried nothing at all. One unreadable question of a split
      // catalog is the whole decision unread: the commands it was asked about
      // are as unaccounted for as if the question had never been answered.
      if (choice?.type !== "choice" || typeof choice.choice !== "string") {
        return { kind: "failed", failure: { ok: false, reason: "empty" } } as const
      }
      const probability = choice.probabilities?.[choice.choice]
      reads.push({
        command: offered.has(choice.choice) ? choice.choice : undefined,
        confidence: typeof probability === "number" && Number.isFinite(probability) ? probability : 0
      })
    }
    const isCommand = isCommandProbability(answer.answers, split)
    if (isCommand === undefined) return { kind: "failed", failure: { ok: false, reason: "empty" } } as const
    const impossible = answer.answers["impossible"]
    /*
     * Exactly one question may name a command. Several is ambiguity: no
     * probability from one question measures its command against another
     * question's, so neither is the answer and the concierge takes the turn.
     *
     * The confidence logged is the named command's own probability; when
     * every question said `none`, it is the least sure of them, which for one
     * question is that question's own probability, as it always was.
     * Ambiguity is measured by no probability at all.
     */
    const named = reads.filter((read) => read.command !== undefined)
    const decided = named.length === 1 ? named[0] : undefined
    const noneConfidence = named.length === 0 ? Math.min(...reads.map((read) => read.confidence)) : 0
    return {
      kind: "decided",
      decision: {
        command: decided?.command,
        confidence: decided?.confidence ?? noneConfidence,
        isCommand,
        impossible: impossible?.type === "choice" && typeof impossible.choice === "string" &&
            impossible.choice in FRONT_DOOR_IMPOSSIBLE_CRITERIA
          ? impossible.choice
          : FRONT_DOOR_NONE
      }
    } as const
  })

const ndjson = (frames: ReadonlyArray<AgentTurnFrame>, headers: Record<string, string>): Response =>
  new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""), {
    status: 200,
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", ...headers }
  })

/* This route's own refusal: the code names the status, and the caller's headers ride along. */
const refusal = routeRefusal

/**
 * A Jev that did not answer, as the turn route reports it. The mapping is the
 * one a cloud role turn already uses for its own unavailable model
 * (cloudRoleTurn.ts): the provider's own rate limit is 429, any other refusal
 * is 502, a 200 this client cannot read is 502 `model_no_answer`, the
 * deadline is 504, and an unreachable host is 502. One vocabulary, so a
 * client that can read "the Librarian's model is down" reads this too.
 */
export const frontDoorRefusal = (
  failure: Exclude<JevAnswer, { readonly ok: true }>,
  headers: Record<string, string>
): Response => {
  const code = failure.reason === "http"
    ? failure.status === 429 ? "model_rate_limited" : "upstream_refused"
    : failure.reason === "empty"
    ? "model_no_answer"
    : failure.reason === "timeout"
    ? "upstream_timeout"
    : failure.reason === "unreachable"
    ? "upstream_unreachable"
    : "out_of_credit"
  return refusal(code, jevFailureMessage(failure), headers, jevFailureDetail(failure))
}

/** The arguments of the one tool call a routed turn emits: execute, by name, with no args. */
export const frontDoorArguments = (command: string): string => JSON.stringify({ action: "execute", name: command })

/**
 * The frames a routed turn answers with: the tool call the concierge would
 * have emitted, then the `tool_call` done that ends the leg. The client
 * executes the call and posts the continuation, which `frontDoorContinuation`
 * below recognises and answers.
 */
export const frontDoorFrames = (runId: string, command: string, callId: string): ReadonlyArray<AgentTurnFrame> => [
  { runId, type: "tool_call", call_id: callId, name: FRONT_DOOR_TOOL, arguments: frontDoorArguments(command) },
  { runId, type: "done", reason: "tool_call" }
]

/**
 * The command a continuation leg is answering, when that leg answers a call
 * THIS module minted. The client appends the function_call /
 * function_call_output pair to the transcript verbatim, so the minted call id
 * is the whole recognition: no state, no registry, nothing to expire.
 */
export const frontDoorContinuation = (body: TurnRequest): string | undefined => {
  const last = body.messages[body.messages.length - 1]
  if (last === undefined || !("type" in last) || last.type !== "function_call_output") return undefined
  if (!last.call_id.startsWith(FRONT_DOOR_CALL_PREFIX)) return undefined
  for (let index = body.messages.length - 2; index >= 0; index -= 1) {
    const message = body.messages[index]
    if (message === undefined || !("type" in message) || message.type !== "function_call") continue
    if (message.call_id !== last.call_id) continue
    try {
      const parsed = JSON.parse(message.arguments) as { readonly name?: unknown }
      return typeof parsed.name === "string" && parsed.name !== "" ? parsed.name : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * The continuation leg's answer: `stop`, and not one word.
 *
 * The transcript already carries the registry's own honest act line for this
 * call, and the client keeps that line as the turn's assistant words, so the
 * assistant has nothing left to say. This leg used to echo `/<command>` as a
 * text delta, because a turn with no text renders as "Smithers Cloud returned
 * an empty response" — and that echo became a second bubble under every act
 * line, saying again what the line already said and reading as success even
 * when the act had failed. The client now reads the minted call id and takes
 * this leg's silence for what it is: the act was the answer.
 */
export const frontDoorContinuationFrames = (runId: string): ReadonlyArray<AgentTurnFrame> => [
  { runId, type: "done", reason: "stop" }
]

/** One appended row, in the recommend log's own shape. */
const logDecision = (
  body: TurnRequest,
  offered: number,
  decision: FrontDoorDecision,
  routed: boolean,
  model: string
): Effect.Effect<void, never, RecommendLogStore> =>
  Effect.gen(function*() {
    const store = yield* RecommendLogStore
    const digest = yield* sha256Hex(tailText(frontDoorTail(body)))
    yield* store.append({
      at: new Date().toISOString(),
      repo: frontDoorRepo(body),
      tailDigest: digest,
      commandCount: offered,
      commands: decision.command === undefined ? [] : [decision.command],
      model,
      frontDoor: { confidence: decision.confidence, impossible: decision.impossible, routed },
      outcome: null
    })
  })

/**
 * The front door, as the turn route calls it: the routed turn's response, the
 * refusal a Jev that did not answer earns, or `undefined` to spend the
 * upstream because Jev said the concierge should answer.
 *
 * The ceilings are already spent by the time this runs, so a routed turn
 * still counts as a turn — the user asked for one and got an answer.
 */
export const handleFrontDoor = (
  body: TurnRequest,
  headers: Record<string, string>
): Effect.Effect<Response | undefined, never, Transport | ServerConfig | RecommendLogStore> =>
  Effect.gen(function*() {
    // The decision model this turn armed (the `front-door` seat). A binding
    // this deployment does not allow refuses the turn before anything is
    // spent: neither the default Jev nor the concierge answers in its place.
    const armed = planDecisionModel(body.decisionModel, yield* ServerConfig)
    if (!armed.ok) return modelRefusal(armed.failure, headers)
    // A leg answering this Worker's own tool call: deterministic, no model.
    const continued = frontDoorContinuation(body)
    if (continued !== undefined) return ndjson(frontDoorContinuationFrames(body.runId), headers)
    const commands = body.commands
    // An older client that offers no catalog, and a tool-loop continuation,
    // are turns the front door never read: the concierge answers them, as it
    // always did.
    if (commands === undefined || !isFrontDoorTurn(body)) return undefined
    const read = yield* askFrontDoor(body, commands, armed.modelId)
    switch (read.kind) {
      case "skipped":
        return undefined
      case "unconfigured":
        return refusal("seam_not_configured", "Smithers can't read this turn on this deployment.", headers, {
          seam: "front door",
          cause: "AI_GATEWAY_API_KEY is unset"
        })
      case "failed":
        return frontDoorRefusal(read.failure, headers)
      case "decided": {
        const decision = read.decision
        const routed = decision.command !== undefined && decision.confidence >= FRONT_DOOR_CONFIDENCE_FLOOR &&
          decision.isCommand >= FRONT_DOOR_IS_COMMAND_FLOOR
        yield* logDecision(body, commands.length, decision, routed, armed.modelId)
        // Jev's own answer: `none`, or a command it is not sure enough about.
        // The concierge is what Jev decided on, so this is not a fallback.
        if (!routed) return undefined
        const callId = `${FRONT_DOOR_CALL_PREFIX}${crypto.randomUUID()}`
        return ndjson(frontDoorFrames(body.runId, decision.command!, callId), headers)
      }
    }
  })
