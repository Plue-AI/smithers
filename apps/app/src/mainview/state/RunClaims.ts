/*
 * Wave 12 §1 — result claims are DETERMINISTIC.
 *
 * Wave 10 §2a taught that a deterministic affordance must not route through the
 * model. Wave 11 proved the same holds for result CLAIMS: with a run card beside
 * it truthfully reading *Running*, the deployed model wrote
 *
 *   The workflow "summarize-open-issues" has been created and is now running
 *
 * — an invented name and a creation that had not happened. The tool result was
 * unmistakable, the system prompt said not to, and it rounded up anyway. Prompt
 * discipline is not a mechanism.
 *
 * So the claim surface stops being the model's. After a run-launch tool call the
 * client renders the model's prose for that turn ONLY if it makes no claim about
 * run state; otherwise the deterministic line below is substituted. Blunt on
 * purpose: a suppressed hallucination is invisible, a shipped one is a truth-bar
 * failure. Nothing here touches the store or the DOM, so the rule is unit-pinned.
 */

import { canonicalCommandName } from "@smthrs/ui/command-line"
import { ASK_HONEST_LINES, type ImpossibleAskClass } from "./Instructions"

/** The commands that launch a run on the user's workspace. */
export const RUN_LAUNCH_COMMANDS: ReadonlyArray<string> = ["flow.create", "flow.run"]

/**
 * The command a model tool call would launch a run with, if any. The model
 * reaches the app through the one `commands` tool, so the launch is named
 * inside its JSON arguments, in any spelling the execution boundary accepts
 * (leading slash, surrounding whitespace); a direct command name is accepted
 * too.
 */
export const runLaunchCommandOf = (toolName: string, toolArguments: string): string | undefined => {
  if (RUN_LAUNCH_COMMANDS.includes(toolName)) return toolName
  if (toolName !== "commands") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(toolArguments)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  if (!("action" in parsed) || !("name" in parsed) || parsed.action !== "execute" || typeof parsed.name !== "string") return undefined
  // The same spelling execution matches on (agentTools.ts): a slash-prefixed
  // or padded name launches the run, so it must arm the claim gate too.
  const name = canonicalCommandName(parsed.name)
  return RUN_LAUNCH_COMMANDS.includes(name) ? name : undefined
}

/**
 * A saved request or confirmed launch arms claim suppression. A refusal,
 * unknown command or chooser leaves the model free to describe that outcome.
 *
 * `flow-requested` is the authoring door's saved request (controller/
 * flowAuthoring.ts). It is a durable request exactly as `run-requested` is,
 * and it was the whole of `flow.create`'s answer the moment the flow builder
 * was on, so a gate reading only `run-` left the deployed model free to write
 * "has been created" over a run that had not launched.
 */
export const toolResultLaunchedRun = (result: string): boolean =>
  !result.startsWith("failed:") && !result.startsWith("unknown-") && /\b(?:run|flow)-(?:started|requested)\b/.test(result)

/** What the run is called, in the vocabulary a claim would use. */
const RUN_SUBJECT = /\b(workflow|workflows|run|runs|flow|flows|automation|pipeline|job|it|that|this|they|everything)\b/i

/**
 * The state vocabulary a claim rides on. Any of these beside a run subject is a
 * statement about run state — including the merely optimistic ones ("should be
 * done shortly"), which are claims about the future the card alone can make.
 */
const RUN_STATE =
  /\b(created|creating|creation|made|built|building|generated|set ?up|added|saved|written|wrote|exists|ready|live|deployed|published|installed|running|ran|started|starting|launched|kicked off|underway|in progress|finished|finishing|complete|completed|completing|done|succeeded|success|failed|failing|working|now|already|shortly|soon)\b/i

/**
 * Does this prose make a claim about the state of a run? Deliberately broad: the
 * cost of suppressing an innocent sentence is one deterministic line the user
 * can read beside a truthful card; the cost of missing one is a lie on screen.
 */
export const claimsRunState = (text: string): boolean => {
  const prose = text.trim()
  if (prose === "") return false
  return RUN_SUBJECT.test(prose) && RUN_STATE.test(prose)
}

/**
 * The one thing the client is willing to say about a launch, per command.
 *
 * The brief drafted this line as "…the card below shows its real progress",
 * and the rendered transcript makes that wording false: the run card is minted
 * during the tool call, so it sits ABOVE this line in the common path — and
 * BELOW it when the model streamed a preamble first (the message already
 * exists at an earlier ordinal, and the substitution edits it in place). A line
 * whose whole job is to stop the surface making unbacked claims may not make
 * one about its own layout, so it names the card instead of pointing at it.
 */
export const deterministicRunLine = (command: string): string =>
  command === "flow.run" || command === "flow.create"
    ? "Run requested."
    : "I started that run — the run card shows its real progress."

/*
 * Wave 13 §F — capability theater, caught where detection is honest.
 *
 * The generated capability section (Instructions.ts) is the primary lever; this
 * is the backstop for the one turn shape where a deterministic detector can
 * tell an offer from a conversation: a LAUNCH turn, where the model just asked
 * the app to do something and its prose rides beside a real run card. The live
 * F-1 failure was exactly this shape — "I can set up a Smithers workflow that
 * drafts and emails a summary …" — an offer of an effect no connector has,
 * laundered through a workflow.
 *
 * The detector fires only when an OFFER construction and a NAMED impossible
 * effect co-occur; general conversation about email or Slack in a turn that
 * launched nothing never passes through here (renderedRunTurnText runs only
 * for launch turns), so this censors nothing the wave-12 gate didn't already
 * own.
 *
 * Two things are load-bearing, and the launch-morning transcript proves both.
 *
 * The apostrophe: the deployed model writes the TYPOGRAPHIC one — every §F
 * answer says "can’t" (U+2019), not "can't" — and that same blindness cost the
 * checklist harness two false failures this morning. Matching only the ASCII
 * form inverts the rule: "I can’t post to Slack yet" reads as "I can" beside
 * "Slack", so the ONE honest answer §F asks for would be the answer this gate
 * discards. Prose is normalized before either pattern sees it.
 *
 * The offer anchor: every offer phrase is SPEAKER-SCOPED ("I" or "we"). A
 * bare "set up" also appears in the honest refusal itself ("…because no
 * Slack connector is set up"), so an unanchored verb reads a refusal as an
 * offer. What survives is only a model speaking about what IT will do —
 * which still catches the laundered form ("I can't do it directly, but I'll
 * set up a workflow that emails your team"), because a workflow calls the
 * same catalog. The "we" forms joined in wave 13c: the live §F-4/§F-5
 * laundering spoke as "we can set up a workflow that…", and a plural offer
 * launders exactly like a singular one.
 */
const CURLY_APOSTROPHES = /[‘’ʼʹ‛´`]/g

/** The model's prose with typographic apostrophes folded to the ASCII one. */
const normalizeApostrophes = (text: string): string => text.replace(CURLY_APOSTROPHES, "'")

const OFFER_PHRASE =
  /\b(i can(?!'?t\b| ?not\b)|i'll|i will|i could|i'm going to|i am going to|i'm setting up|i am setting up|i've set up|i have set up|i'm able to|i am able to|let me|shall i|want me to|would you like me to|we can(?!'?t\b| ?not\b)|we'll|we will|we could|we're going to|we are going to|we're able to|we are able to)\b/i
/*
 * The named can't-yets, in the model's own vocabulary — the same class the
 * generated capability section spells out (Instructions.ts NAMED_CANT_YETS),
 * so the prompt and this backstop can never disagree about what does not
 * exist: messaging (§F-1, §F-3), the user's machine (§F-2), and writing to a
 * repository (§F-4, §F-5).
 */
const IMPOSSIBLE_EFFECT =
  /\b(e-?mails?|slack|sms|text messages?|whatsapp|tweet|your (laptop|machine|computer|hard drive|home directory|file system|filesystem)|local (file|files|filesystem)|push(es|ed|ing)? (it |them |straight |right |directly )*to (the )?(main|master|branch)|pull request|pr link)\b/i

/*
 * The offer and the effect must land in the SAME sentence. An honest can't-yet
 * names the impossible effect and then names the real next step — "I can't open
 * a pull request yet. I can start a workflow that prepares the change." — and
 * whole-text matching reads those two sentences as one offer, discarding the
 * exact answer §F asks for. Sentence scope is what makes this detector honest
 * rather than merely blunt.
 */
const SENTENCES = /(?<=[.!?…])\s+|\n+/

/**
 * Does this prose offer an effect the catalog cannot have? Deterministic and
 * deliberately narrow: one sentence carrying a first-person offer phrase beside
 * a named impossible effect.
 */
export const offersImpossibleCapability = (text: string): boolean => {
  const prose = normalizeApostrophes(text).trim()
  if (prose === "") return false
  return prose
    .split(SENTENCES)
    .some((sentence) => OFFER_PHRASE.test(sentence) && IMPOSSIBLE_EFFECT.test(sentence))
}

/**
 * The rendered prose for a turn that launched a run: the model's own words when
 * they claim nothing, the deterministic line when they do.
 */
export const renderedRunTurnText = (command: string, modelText: string): string =>
  claimsRunState(modelText) || offersImpossibleCapability(modelText)
    ? deterministicRunLine(command)
    : modelText

/*
 * Wave 13c — the truth bar has no tail: the response to an ACTION ask.
 *
 * Wave 13 armed the offer detector only on launch turns, the one shape where
 * a claim rides beside a real run card. The one live miss after that (§F-5,
 * observed once in eight runs) laundered the impossible act on a PLAIN answer
 * turn — no tool call at all, just "we can create a Smithers workflow that
 * creates the PR and then returns the link — once you approve the run, the PR
 * will be opened". Prompt discipline alone leaves that tail open.
 *
 * Detection here is honest because it keys on the ASK, not the answer: the
 * five §F classes (email, local files, unconnected messaging tools, direct
 * push, PR-with-link) are readable from the user's own words, so ONLY a turn
 * whose ask names an impossible class is held and reviewed. Conversation
 * ABOUT email, and asks for things the catalog can do, never enter here —
 * this is not a general censor. When the answer to such an ask offers the act
 * (directly or through a workflow) instead of the honest can't-yet, the
 * class's deterministic honest line (Instructions.ts ASK_HONEST_LINES — the
 * same vocabulary the generated capability section states) is rendered
 * instead.
 */

/*
 * The ask shapes, one per class. Each requires an ACTION word beside the
 * class noun, so "what would you do about email?" and "make me a workflow
 * that summarizes issues" classify as nothing and their turns stream
 * untouched.
 *
 * Two of the five nouns are also nouns for things the catalog CAN read, and
 * a loose action word beside them turns this gate into the censor §1 forbids:
 *
 *   "make me a workflow that summarizes open PRs"  — "make" … "PRs"
 *   "summarize the last push to main"              — "push" … "main"
 *
 * Both are ordinary, POSSIBLE asks (a run reads the loaded repositories),
 * and both keyed the impossible class, so the answer would have been replaced
 * with "I can't open a pull request" / "I can't push to a branch" — the truth
 * bar failing in the other direction, the app lying about what it cannot do.
 * So the two GitHub-noun patterns are written to the grammar that separates
 * the act from the reading:
 *
 * - `push` as a VERB, never the noun: "the/my/last/each push to main" is a
 *   thing that happened, "push my changes to main" is an act being asked for.
 * - `pr` requires the verb to GOVERN the PR ("open a PR", "file PRs for …"),
 *   never merely to appear within sixty characters of it; and "open PRs" as
 *   the adjective+noun state is not the verb "open" (see CLASS_EFFECT).
 */
const ASK_PATTERNS: ReadonlyArray<readonly [ImpossibleAskClass, RegExp]> = [
  [
    "email",
    /\b(send|draft|compose|fire off|shoot over|dash off)\b[^!?\n]{0,100}\be-?mails?\b|\be-?mail\s+(my|the|your|to)\b/i
  ],
  [
    "local-files",
    /\b(read|open|show|summari[sz]e|check|what'?s in)\b[^!?\n]{0,120}\b(my (laptop|machine|computer|home director\w+|hard drive|desktop|file ?system)|local (files?|file ?system))\b/i
  ],
  [
    "messaging",
    /\b(post|send|message|dm|notify|ping|share)\b[^!?\n]{0,80}\b(slack|whatsapp|sms|text messages?|discord|(ms|microsoft) teams|messaging apps?)\b/i
  ],
  [
    "push",
    /(?<!\b(the|a|an|my|your|our|their|its|last|latest|recent|each|every|first|next|that|this|those|these)\s)\bpush(es|ing)?\b[^!?\n]{0,100}\b(main|master|branch|github|repos?)\b/i
  ],
  [
    "pr",
    /\b(open|create|make|raise|submit|file)\s+(up\s+)?(a|an|the|that|this|one|me a|us a)\s+(draft\s+)?(pull requests?|prs?)\b|\b(open|create|make|raise|submit|file)\s+(pull requests?|prs?)\s+(for|against|on|with|from)\b|\b(pull request|pr) links?\b/i
  ]
]

/**
 * The impossible-ask class the user's message asks for, if any — detected
 * from the ASK alone, before the model speaks. Ordinary conversation
 * classifies as nothing and is never held.
 */
export const impossibleAskOf = (userText: string): ImpossibleAskClass | undefined => {
  const ask = normalizeApostrophes(userText).trim()
  if (ask === "") return undefined
  for (const [askClass, pattern] of ASK_PATTERNS) {
    if (pattern.test(ask)) return askClass
  }
  return undefined
}

/*
 * The class effect, in the answer's vocabulary. These are deliberately
 * broader than the launch gate's IMPOSSIBLE_EFFECT — the ask already named
 * the class, so the answer side only has to catch the offer riding beside
 * the effect, including the workflow-laundered form ("we can create a
 * workflow that creates the PR").
 *
 * Two precisions on the PR pattern, both about not discarding an honest
 * answer:
 *
 * - A USER-performed act in the honest next step ("you open the PR") is not
 *   an offer, so the pattern looks away when "you" does the verb — the
 *   class's own honest line passes its own gate.
 * - "open PRs" is far more often the ADJECTIVE than the verb: "I can list
 *   your open PRs" offers a reading the catalog really can do. So the verb
 *   reading of "open" is refused in the frames where it is plainly
 *   attributive ("your/the/all open PRs") or governed by a reading verb
 *   ("summarizes open PRs"). Every other verb — create, file, submit, raise
 *   — has no adjectival reading and needs no such guard.
 */
const CLASS_EFFECT: Record<ImpossibleAskClass, RegExp> = {
  email: /\be-?mails?\b/i,
  "local-files": /\b(files?|file ?systems?|home director\w+|hard drives?|laptops?|machines?|computers?|desktops?)\b/i,
  messaging: /\b(slack|whatsapp|sms|text messages?|messaging apps?|discord|ms teams|microsoft teams)\b/i,
  push: /\bpush(es|ed|ing)?\b/i,
  pr: new RegExp(
    [
      // The verbs with no adjectival reading — the object may be bare.
      String
        .raw`(?<!\byou\s)(?<!\byou all\s)\b(create|creates|created|creating|make|makes|made|file|files|filed|submit|submits|submitted|raise|raises|raised)\s+(a\s+|an\s+|the\s+|that\s+|this\s+|your\s+|one\s+)?(draft\s+)?(pull requests?|prs?)\b`,
      // "open", only where it is the verb and not "your/the/all open PRs".
      String
        .raw`(?<!\byou\s)(?<!\byou all\s)(?<!\b(your|my|our|their|the|all|any|these|those|of|list|lists|show|shows|summari[sz]e|summari[sz]es|summari[sz]ing|review|reviews|reviewing|check|checks|track|tracks|watch|watches|read|reads|find|finds|count|counts|triage|triages)\s)\b(open|opens|opened|opening)\s+(a\s+|an\s+|the\s+|that\s+|this\s+|your\s+|one\s+)?(draft\s+)?(pull requests?|prs?)\b`,
      String.raw`\bpr links?\b`,
      String.raw`\b(pull requests?|prs?)\s+(will be|is being|gets?|would be)\s+(opened|created|made)\b`
    ].join("|"),
    "i"
  )
}

/**
 * Does this answer to an impossible-class ask OFFER the act (or a workflow
 * performing it)? Sentence-scoped like the launch gate: a refusal sentence
 * never carries an offer phrase, so an honest can't-yet — which names the
 * effect in the sentence that refuses it — passes through.
 */
export const offersAskClassAct = (askClass: ImpossibleAskClass, text: string): boolean => {
  const prose = normalizeApostrophes(text).trim()
  if (prose === "") return false
  const effect = CLASS_EFFECT[askClass]
  return prose.split(SENTENCES).some((sentence) => OFFER_PHRASE.test(sentence) && effect.test(sentence))
}

/**
 * The rendered prose for a turn answering an impossible-class ask: the
 * model's own words when they offer nothing impossible, the class's
 * deterministic honest line when they do.
 */
export const renderedAskTurnText = (askClass: ImpossibleAskClass, modelText: string): string =>
  offersAskClassAct(askClass, modelText) ? ASK_HONEST_LINES[askClass] : modelText
