/**
 * Character suites: a role, a world, and the cases that pin its behaviour.
 *
 * A suite directory holds `suite.yaml` and `cases/*.yaml`. `suite.yaml`
 * names the role, the organization directory its instructions come from,
 * the world, the seats, the suite-wide voice rules (forbidden openers and
 * phrases, the jargon list, how references are linked) and the judge's
 * calibration file. A case is one scenario: a world patch, the conversation
 * so far, the event that starts the turn, what must and must not happen, a
 * golden transcript and the counterexamples that must fail. A case with
 * `turns` is a conversation: each turn's reply joins the history of the next.
 *
 * Paths in `suite.yaml` are relative to the suite directory.
 *
 * @since 0.1.0
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import type * as Subject from "./subject.ts"
import type * as World from "./world.ts"

/** An inclusive count bound. */
export interface Bound {
  readonly min?: number | undefined
  readonly max?: number | undefined
}

/** Text expectations; `include` entries that are lists are any-of groups. */
export interface TextExpect {
  readonly words?: Bound | undefined
  readonly include?: ReadonlyArray<string | ReadonlyArray<string>> | undefined
  readonly exclude?: ReadonlyArray<string> | undefined
  readonly links?: ReadonlyArray<string | ReadonlyArray<string>> | undefined
  readonly questions?: Bound | undefined
}

/** A tool-call expectation: how many calls match, and what their inputs say. */
export interface CallExpect {
  readonly tool: string
  readonly where?: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>> | undefined
  readonly min?: number | undefined
  readonly max?: number | undefined
  readonly include?: ReadonlyArray<string | ReadonlyArray<string>> | undefined
  readonly exclude?: ReadonlyArray<string> | undefined
}

/** Everything a turn is scored on. */
export interface Expect {
  /** The reply posted where the event arrived. `empty: true` expects no reply. */
  readonly reply?:
    | (TextExpect & {
      readonly empty?: boolean | undefined
      /**
       * Also count notes sent to the requester when closing its request
       * (`request_resolve`) as the reply: answering through the request is
       * answering.
       */
      readonly orNote?: boolean | undefined
    })
    | undefined
  /** Direct messages to Will (`owner_message`). */
  readonly owner?:
    | (TextExpect & { readonly count?: Bound | undefined; readonly urgent?: boolean | undefined })
    | undefined
  /** Each entry must hold; an `anyOf` entry holds when one of its members does. */
  readonly calls?: ReadonlyArray<CallExpect | { readonly anyOf: ReadonlyArray<CallExpect> }> | undefined
  /** Terms this case may use although the suite forbids them (e.g. the jargon Will asked about). */
  readonly allow?: ReadonlyArray<string> | undefined
  /** Every `calendar_create` and `calendar_move` must be a valid slot of this many minutes under the suite's booking rules. */
  readonly booking?: { readonly minutes: number; readonly before?: string | undefined } | undefined
  /** Check agent-visible text for the world's private markers (default true). */
  readonly leakage?: boolean | undefined
  /** Apply the suite's voice rules to Will-facing text (default true). */
  readonly voice?: boolean | undefined
  /** Ask the rubric judge (default true). */
  readonly judge?: boolean | undefined
  /** What ideal behaviour looks like here, for the judge. */
  readonly focus?: string | undefined
}

/** Who a message is from: `owner` (Will), a role id, or `system`. */
export interface Message {
  readonly from: string
  readonly text: string
  readonly at?: string | undefined
}

/** One turn: the event, its expectations, and its recorded answers. */
export interface Turn {
  readonly trigger: Message
  readonly expect: Expect
  readonly golden?: Subject.Transcript | undefined
  readonly counterexamples?:
    | ReadonlyArray<Subject.Transcript & { readonly label: string; readonly source?: string | undefined }>
    | undefined
}

/** One scenario. */
export interface Case {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly tests: ReadonlyArray<string>
  readonly where: string
  readonly world: World.Patch
  readonly history: ReadonlyArray<Message>
  readonly turns: ReadonlyArray<Turn>
  readonly file: string
}

/** Suite-wide rules. */
export interface Suite {
  readonly dir: string
  readonly name: string
  readonly role: string
  readonly org: string
  readonly world: string
  readonly seat: string
  readonly judgeSeat: string
  readonly voice: {
    readonly openers: ReadonlyArray<string>
    readonly forbid: ReadonlyArray<string>
    readonly jargon: ReadonlyArray<string>
  }
  readonly references: ReadonlyArray<{ readonly pattern: string; readonly url: string }>
  readonly booking: { readonly days: ReadonlyArray<number>; readonly start: string; readonly end: string }
  readonly calibration: string | undefined
  /** Tokens per percent of the weekly subscription limit, per seat: fresh input, cached input, output. */
  readonly usageWeights: Readonly<
    Record<string, { readonly fresh: number; readonly cached: number; readonly output: number }>
  >
  readonly cases: ReadonlyArray<Case>
}

const at = (base: string, path: string): string => (isAbsolute(path) ? path : resolve(base, path))

const readYaml = (path: string): Record<string, unknown> =>
  (parseYaml(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>

const strings = (value: unknown): Array<string> => (Array.isArray(value) ? value.map(String) : [])

/** Loads a word list: a YAML list, or a YAML map whose values are lists. */
const wordList = (path: string): Array<string> => {
  const data = parseYaml(readFileSync(path, "utf8")) as unknown
  if (Array.isArray(data)) return data.map(String)
  if (typeof data === "object" && data !== null) return Object.values(data).flatMap(strings)
  return []
}

const turnOf = (raw: Record<string, unknown>): Turn => ({
  trigger: raw.trigger as Message,
  expect: (raw.expect ?? {}) as Expect,
  golden: raw.golden as Subject.Transcript | undefined,
  counterexamples: raw.counterexamples as Turn["counterexamples"]
})

/** Parses one case file. */
export const parseCase = (file: string, raw: Record<string, unknown>): Case => {
  const turns = Array.isArray(raw.turns) ? (raw.turns as Array<Record<string, unknown>>).map(turnOf) : [turnOf(raw)]
  for (const [index, turn] of turns.entries()) {
    if (turn.trigger === undefined || typeof turn.trigger.text !== "string") {
      throw new Error(`${file}: turn ${index + 1} has no trigger.text`)
    }
  }
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? raw.id ?? ""),
    category: String(raw.category ?? "uncategorised"),
    tests: strings(raw.tests),
    where: String(raw.where ?? "dm"),
    world: (raw.world ?? {}) as World.Patch,
    history: (raw.history ?? []) as ReadonlyArray<Message>,
    turns,
    file
  }
}

/** Loads a suite directory. `only` keeps the named cases. */
export const load = (dir: string, only?: ReadonlyArray<string>): Suite => {
  const base = resolve(dir)
  const raw = readYaml(join(base, "suite.yaml"))
  const voice = (raw.voice ?? {}) as Record<string, unknown>
  const jargonFiles = strings(voice.jargon)
  const booking = (raw.booking ?? {}) as Record<string, unknown>
  const caseDir = join(base, "cases")
  const cases = readdirSync(caseDir).filter((name) => name.endsWith(".yaml")).sort().map((name) => {
    const file = join(caseDir, name)
    const parsed = parseCase(file, readYaml(file))
    if (parsed.id !== name.replace(/\.yaml$/, "")) throw new Error(`${file}: id must be the file name`)
    return parsed
  })
  const kept = only === undefined || only.length === 0 ? cases : cases.filter((c) => only.includes(c.id))
  const calibration = typeof raw.calibration === "string" ? at(base, raw.calibration) : undefined
  return {
    dir: base,
    name: String(raw.name ?? raw.role),
    role: String(raw.role),
    org: at(base, String(raw.org)),
    world: at(base, String(raw.world)),
    seat: String(raw.seat ?? "openai:gpt-6-astra"),
    judgeSeat: String(raw.judgeSeat ?? "openai:gpt-6-sol"),
    voice: {
      openers: strings(voice.openers),
      forbid: strings(voice.forbid),
      jargon: jargonFiles.flatMap((path) => wordList(at(base, path))).concat(strings(voice.terms))
    },
    references: (raw.references ?? []) as Suite["references"],
    booking: {
      days: (booking.days as Array<number> | undefined) ?? [1, 2, 3, 4, 5],
      start: String(booking.start ?? "09:30"),
      end: String(booking.end ?? "17:30")
    },
    calibration: calibration !== undefined && existsSync(calibration) ? calibration : undefined,
    usageWeights: (raw.usageWeights ?? {}) as Suite["usageWeights"],
    cases: kept
  }
}

/** The directory a suite file lives in, for resolving siblings. */
export const dirOf = (file: string): string => dirname(file)
