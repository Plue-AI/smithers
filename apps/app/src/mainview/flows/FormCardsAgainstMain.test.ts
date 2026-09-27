/*
 * THE FORM LAW, measured as a DIFFERENTIAL over the WHOLE door space against
 * `main@origin`.
 *
 * Three passes of this chain shipped a rule stated over a class and tested on
 * a sample. R102 compared seven lines, R102b compared seven, and R102d's own
 * table compared eighteen; a reviewer who swept every (flow, args) pair found
 * that the rule those tables passed had deleted 81 distinct sentences over 87
 * flows — 1054 rows — while the report said it cost one. A differential over a
 * sample proves nothing about a rule stated over a class, so this file does
 * not hold a table of lines. It ENUMERATES: every flow the registry answers
 * with, times an argument set generated from that flow's own declared fields,
 * through the real door (`controller.renderFlowForm`), and compares every row
 * to the card `main@origin` opens for it.
 *
 * A flow added later is swept without anyone editing anything, and a flow the
 * baseline has never seen is still held to the law below rather than skipped.
 *
 * `FormCardsAgainstMain.main.json` is that baseline, captured through this
 * same harness at the `main@origin` its own `capturedAt` names. It was read
 * twice — at `0e876a2566fe` and again at `6cc28aec6f9a`, 41 commits later —
 * and all 8719 rows were byte-identical, so those 41 commits changed no card
 * and the baseline describes main today. Re-capture it with
 * `FORM_CARDS_BASELINE=write bun test src/mainview/flows/FormCardsAgainstMain.test.ts`
 * IN A WORKSPACE ON `main@origin` AND NOWHERE ELSE, and say in the commit
 * which revision it was read at — a baseline captured on a branch is the
 * branch agreeing with itself, which is the failure this file exists to stop.
 *
 * `DECLARED` is every move this branch makes on purpose, with the reason and
 * the number of rows it moves. A difference that is not declared, and a
 * declared move whose row count has changed, are both failures.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { AGENT_ROLES, AgentRoleSchema } from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { Harness } from "@smthrs/rpc/LocalApp"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import type { Card } from "../state/AppState"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const EVERYTHING: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: [...RuntimeCapabilitySchema.options],
  authFlow: "both",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const HARNESSES: ReadonlyArray<Harness> = [
  {
    id: "claude",
    displayName: "Claude Code",
    status: "signed-in",
    binary: "/usr/local/bin/claude",
    version: "1.0.0",
    account: { email: "will@example.com" },
    launch: { argv: ["claude"] },
    models: { suggestions: ["claude-fable-5"], listable: false }
  },
  {
    id: "codex",
    displayName: "Codex",
    status: "api-key",
    binary: "/usr/local/bin/codex",
    version: "1.0.0",
    account: { label: "OPENAI_API_KEY" },
    launch: { argv: ["codex"] },
    models: { suggestions: ["gpt-5.6-sol"], listable: false }
  }
]

const settle = async (ticks = 8): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const agents: Array<AgentRole> = [...AGENT_ROLES]
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: EVERYTHING,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://local.test").pathname
      const method = init?.method ?? "GET"
      if (path === "/api/harnesses") return json(200, { harnesses: HARNESSES })
      if (path === "/api/agents" && method === "GET") return json(200, { agents })
      const put = /^\/api\/agents\/([^/]+)$/.exec(path)
      if (put !== null && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        agents.push(AgentRoleSchema.parse({ id: put[1]!, ...body, delegates: false, builtin: false, createdAt: 100, updatedAt: 101 }))
        return json(201, { agent: agents[agents.length - 1] })
      }
      const models = /^\/api\/harnesses\/([^/]+)\/models$/.exec(path)
      if (models !== null) return json(200, { harnessId: models[1], models: [], source: "suggestions", reason: "no list command" })
      return json(404, { error: { code: "absent", message: `no stub for ${method} ${path}` } })
    }
  })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: true, scopesPlain: null })
  store.dispatch({ type: "harnesses.loaded", actor: "system", harnesses: [...HARNESSES] })
  await controller.loadAgents()
  await settle()
  return { store, controller }
}

const formOf = (store: AppStore, flow: string): Extract<Card, { kind: "flow-form" }> | undefined => {
  const card = store.collections.cards.get(`form-${flow}`)
  return card?.kind === "flow-form" ? card : undefined
}


import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { formFieldsFor } from "@smthrs/ui/flow-form"
import { nameOf } from "./registry"

/** What a person can see after typing one line: the door's answer and the card it opened. */
interface CardAsRead {
  readonly rendered: boolean
  /** The fields the door reports still unanswered. */
  readonly missing: ReadonlyArray<string> | null
  /** Every field label on the card, in order. */
  readonly fields: ReadonlyArray<string> | null
  /** What the line put in them. */
  readonly draft: Readonly<Record<string, unknown>> | null
  /** The one sentence under them, or `null` for a card that says nothing. */
  readonly error: string | null
  /** Nothing may throw at a door a person can type at. */
  readonly threw: string | null
}

interface Row extends CardAsRead {
  readonly flow: string
  readonly shape: string
  readonly args: string | undefined
}

const REPO = "codeplanesmithers/canary"

/**
 * The argument set. The fixed shapes are the ones a person actually types —
 * nothing, one word, several, a repository, a cron, malformed JSON, a flag the
 * door knows and one it does not — and the derived shapes come off each flow's
 * OWN declared fields, so a flow that grows a field grows its own coverage.
 */
const shapesFor = (names: ReadonlyArray<string>): ReadonlyArray<readonly [string, string | undefined]> => {
  const first = names[0]
  const second = names[1]
  const fixed: Array<readonly [string, string | undefined]> = [
    ["bare", undefined],
    ["empty", ""],
    ["one-positional", "one"],
    ["two-positionals", "one two"],
    ["three-positionals", "one two three"],
    ["four-positionals", "one two three four"],
    ["eight-positionals", "a b c d e f g h"],
    ["one-number", "7"],
    ["two-numbers", "7 8"],
    ["three-numbers", "7 8 9"],
    ["zero", "0"],
    ["repo-token", REPO],
    ["repo-token-plus-one", `${REPO} nightly`],
    ["repo-token-plus-two", `${REPO} nightly extra`],
    ["repo-token-plus-cron", `${REPO} nightly 0 9 * * *`],
    ["malformed-json", "{invalid"],
    ["positional-then-malformed-json", `one ${REPO} {invalid`],
    ["json-object", '{"input":1}'],
    ["repo-then-json", `${REPO} {"a":1}`],
    ["unknown-flag", "--nope"],
    ["unknown-flag-with-value", "--nope value"],
    ["positional-then-unknown-flag", "one --nope value"],
    ["quoted-phrase", '"hello world"'],
    ["cron-stars", "* * * * *"],
    ["long-number", "500000"]
  ]
  /* The lines walk W1 typed, at every door rather than only at the one that failed. */
  const walk: Array<readonly [string, string | undefined]> = [
    ["w1-tokens-over", "--tokens 500000"],
    ["w1-tokens-inside", "--tokens 150000"],
    ["w1-minutes-inside", "--minutes 20"],
    ["w1-summarize", "--summarize"],
    ["w1-repo-then-tokens", `${REPO} --tokens 500000`],
    ["w1-both-limits", "--tokens 150000 --minutes 20"]
  ]
  const derived: Array<readonly [string, string | undefined]> = []
  if (first !== undefined && second !== undefined) derived.push([`known-flags:${first}+${second}`, `--${first} one --${second} two`])
  for (const name of names.slice(0, 6)) {
    derived.push([`known-flag:${name}`, `--${name} one`])
    derived.push([`known-flag-number:${name}`, `--${name} 500000`])
  }
  return [...fixed, ...walk, ...derived]
}

const sweep = async (): Promise<ReadonlyArray<Row>> => {
  const initial = await boot()
  const entries = [...initial.controller.commands.entries()]
  await initial.controller.dispose()
  const rows: Array<Row> = []
  // Each flow still exercises every shape against the same fixture. Bound its
  // persistence history here instead of queueing the whole registry's writes
  // in one store; the baseline and all differential assertions stay identical.
  for (const entry of entries) {
    const { store, controller } = await boot()
    try {
      const flow = nameOf(entry)
      const fields = entry.input === undefined ? [] : formFieldsFor(entry.input, entry.metadata.form)
      for (const [shape, args] of shapesFor(fields.map((field) => field.name))) {
        try {
          const rendered = controller.renderFlowForm({ name: flow, args, via: "user" })
          const card = formOf(store, flow)
          rows.push({
            flow, shape, args,
            rendered: rendered !== undefined,
            threw: null,
            missing: rendered === undefined ? null : [...rendered.missing],
            fields: rendered === undefined ? null : card?.payload.fields.map((field) => field.label) ?? null,
            draft: rendered === undefined ? null : card?.payload.draft ?? null,
            error: rendered === undefined ? null : card?.payload.error ?? null
          })
        } catch (cause) {
          rows.push({ flow, shape, args, rendered: false, threw: String(cause), missing: null, fields: null, draft: null, error: null })
        }
      }
    } finally {
      // Compaction FIRST: a sweep of every form otherwise retains thousands of
      // optimistic journal preparations, and a store is not released by being
      // dropped while its live queries still reference its collections — the
      // whole suite slows to a crawl without this. Then dispose, which closes
      // the owner a compaction writes through, so the other order throws.
      await store.compactEvents()
      await controller.dispose()
    }
  }
  return rows
}

/** A value as a reader compares it: a draft is a set of named values, so key order is not a difference. */
const shown = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
      : inner)

/** Everything about the card except its one sentence, as one short stable value. */
const cardDigest = (row: CardAsRead): string => {
  const text = shown([row.rendered, row.threw, row.missing, row.fields, row.draft])
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/** One swept row's name. The separator is a character no flow name or shape name contains. */
const SEPARATOR = "::"
const key = (row: { readonly flow: string; readonly shape: string }): string => `${row.flow}${SEPARATOR}${row.shape}`

interface Baseline {
  readonly capturedAt: string
  readonly sentences: ReadonlyArray<string>
  /** Per row: the index of its sentence, or -1 for a card that says nothing, then the card's digest. */
  readonly rows: Readonly<Record<string, readonly [number, string]>>
}

const BASELINE_PATH = join(import.meta.dir, "FormCardsAgainstMain.main.json")

/** What this branch moves on purpose, why, and over how many of the swept rows. */
interface DeclaredMove {
  readonly flow: string
  /** `card` is the fields, the draft and what is still missing; `sentence` is the one line under them. */
  readonly kind: "card" | "sentence"
  readonly rows: number
  readonly because: string
}

const DECLARED: ReadonlyArray<DeclaredMove> = [
  ...(["runs.list", "github.mirror.retry-ref", "box.open", "box.desktop.open", "desktop"] as const).map(flow => ({
    flow, kind: "sentence" as const, rows: 2,
    because: "Structured button arguments preserve their explicit repository without inventory (#2082). Malformed JSON and unknown fields now receive a grammar diagnostic rather than being interpreted as an identifier or filter."
  })),
  ...(["issues", "issues.list"] as const).map(flow => ({
    flow, kind: "sentence" as const, rows: 1,
    because: "A repository-only issues listing now accepts an explicit unloaded repository with the default open filter (#2082), so the obsolete filter error and its incorrect draft disappear."
  })),
  {
    flow: "issues", kind: "card", rows: 1,
    because: "A repository-only issues listing now accepts an explicit unloaded repository with the default open filter (#2082), so the obsolete filter error and its incorrect draft disappear."
  },
  {
    flow: "issues.list", kind: "card", rows: 35,
    because: "The issues list narrows to chats or tasks with `--kind` (smithers-ui-DESIGN.md §3.1), so the list form gains an optional Kind field: every swept line's card lists it beside Filter and Repository, and the one #2082 row keeps its move."
  },
  ...(["agent.session.view", "agent.session.stop"] as const).map(flow => ({
    flow, kind: "sentence" as const, rows: 1,
    because: "An explicit repository is recognized without loaded inventory (#2075). A repository alone now receives the existing missing-session-id diagnostic instead of being mistaken for the session id; complete id-plus-repository arguments work through every door."
  })),
  {
    flow: "change.split", kind: "sentence", rows: 1,
    because: "A quoted change id without a path now receives the same missing-path refusal as every other incomplete split. The parser preserves the quoted token instead of treating its space as a second argument. No existing sentence is removed."
  },
  {
    flow: "triggers.pause", kind: "card", rows: 6,
    because: "An optional repository slot is skipped while the required slots behind it need every token left, so `/triggers.pause canary-w1-not-registered` fills Slug and the form asks for the repository instead of for the name the person just typed (walk W1, W1-d-doors.json pauseFormFields)."
  },
  {
    flow: "triggers.register", kind: "card", rows: 13,
    because: "The same skip, and the repository-shaped token that buys the slot back: three words reach Flow, Name and Schedule, while `codeplanesmithers/canary nightly` still reaches Repository and Flow (R102 follow-up)."
  },
  {
    flow: "triggers.approve", kind: "card", rows: 12,
    because: "The same skip on the approval's own optional repository. The door is hidden, so no one types these lines; the rows move because the rule is the schema's, not the door's."
  },
  {
    flow: "model.save", kind: "card", rows: 6,
    because: "The same skip over the optional base URL and path, which sit in front of the required credential, so a four-word line fills the required slots rather than the decorative ones."
  },
  {
    flow: "issue.add-flow", kind: "card", rows: 1,
    because: "The same skip over the optional repository that leads the add-flow input, so the second token reaches the description the form is there to collect."
  },
  {
    flow: "issues.create", kind: "card", rows: 36,
    because: "A chat thread is an issue created with `--kind chat` (smithers-ui-DESIGN.md §3.1), so the create form gains an optional Kind field: every swept line's card now lists that field beside Title and Repository; no draft or missing field changes."
  },
  {
    flow: "runs.trace.view", kind: "sentence", rows: 13,
    because: "The graph IS the third view of a run and the step list the fourth, so the line that refuses a bad one has to name them: main@origin says `runs.trace.view needs turns, timeline or graph` and this branch says `runs.trace.view needs turns, timeline, graph or steps` (SlashPayload.ts). Every swept line whose second token is not a view reads the new sentence; no card moves."
  },
  {
    flow: "issue.implement", kind: "card", rows: 33,
    because: "The Fix an issue app (PRODUCT.md D-18) opens this form: the number field is labeled Issue and offers the repository's open issues, and the repository is the active one rather than a field (entries/issue.ts form hints). Every swept line's card lists one field instead of two, and a line the grammar refuses no longer places its owner/repo token; a line it parses still carries its repository as given."
  },
  {
    flow: "triggers.register", kind: "sentence", rows: 6,
    because: "A limit the LINE names meets the rule the FIELD meets: `--tokens 500000` reached the Tokens field and was told nothing on production, while 500000 typed into that field and prepared is refused with the range before any network call (walk W1 item 4c). The register form routes to TriggersSeam.limitsRefusal, so two rows that used to read the grammar's usage line read the range instead, and four that said nothing now say it."
  },
  ...(["review.done", "review.ack", "review.reopen"] as const).flatMap(flow => [
    {
      flow, kind: "card" as const, rows: 36,
      because: "Product words (#2144): the numeric field the review flows collect is labelled Comment id, not Thread id, so every card these lines open renames that one field."
    },
    {
      flow, kind: "sentence" as const, rows: 1,
      because: "Product words (#2144): the refusal names the id the user types as a comment id; the wire field and route still say thread."
    }
  ]),
  {
    flow: "agent.session.new", kind: "card", rows: 38,
    because: "Product words (#2144): the session's free-text field is labelled Request instead of Task; the payload field keeps its name."
  }
]

/* One exhaustive sweep for the whole file; every test below reads the same rows. */
let swept: Promise<ReadonlyArray<Row>> | undefined
const swipe = (): Promise<ReadonlyArray<Row>> => (swept ??= sweep())

describe("the card every slash line opens, against main@origin", () => {
  test("every (flow, args) row matches main@origin except where this branch declares the move", async () => {
    const rows = await swipe()
    if (process.env["FORM_CARDS_BASELINE"] === "write") {
      const sentences = [...new Set(rows.map((row) => row.error).filter((error): error is string => error !== null))].sort()
      const baseline: Baseline = {
        capturedAt: process.env["FORM_CARDS_BASELINE_AT"] ?? "unknown revision",
        sentences,
        rows: Object.fromEntries(rows.map((row) => [key(row), [row.error === null ? -1 : sentences.indexOf(row.error), cardDigest(row)] as const]))
      }
      writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline)}\n`)
      return
    }
    expect(existsSync(BASELINE_PATH)).toBe(true)
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline
    const allowed = new Map(DECLARED.map((move) => [`${move.flow}${SEPARATOR}${move.kind}`, move]))
    const counted = new Map<string, number>()
    const drift: Array<string> = []
    let compared = 0
    for (const row of rows) {
      const at = baseline.rows[key(row)]
      if (at === undefined) continue
      compared += 1
      const [sentenceIndex, digest] = at
      const wasSaying = sentenceIndex === -1 ? null : baseline.sentences[sentenceIndex] ?? null
      const line = row.args === undefined ? `/${row.flow}` : `/${row.flow} ${row.args}`
      const same = { card: digest === cardDigest(row), sentence: wasSaying === row.error }
      for (const kind of ["card", "sentence"] as const) {
        if (same[kind]) continue
        const name = `${row.flow}${SEPARATOR}${kind}`
        if (allowed.get(name) === undefined) {
          drift.push(kind === "sentence"
            ? `${line} — sentence: main@origin says ${shown(wasSaying)}, this branch says ${shown(row.error)}, and nothing declares the move`
            : `${line} — card: its fields, draft or missing list differ from main@origin, and nothing declares the move`)
          continue
        }
        counted.set(name, (counted.get(name) ?? 0) + 1)
      }
    }
    expect(drift).toEqual([])
    /* A declared move that has grown or shrunk is a different claim from the one that was reviewed. */
    expect(DECLARED.map((move) => `${move.flow} ${move.kind}: ${counted.get(`${move.flow}${SEPARATOR}${move.kind}`) ?? 0}`))
      .toEqual(DECLARED.map((move) => `${move.flow} ${move.kind}: ${move.rows}`))
    /* And the sweep has to have been a sweep: a sample cannot see what a sample let through. */
    expect(compared).toBeGreaterThan(6000)
  }, 1_800_000)

  /*
   * The narrowness of the rule, counted rather than asserted. The pass before
   * this one stated "the grammar's reason reaches NO form card" and reported
   * that it cost one sentence; the measured cost was 81 distinct sentences
   * over 87 flows. So this test does not take anyone's word for the size of
   * the subtraction: it counts the sentence-carrying rows at `main@origin`
   * from the baseline and at this branch from the sweep, and states both
   * numbers. Nothing is allowed to go missing, and what is added is the six
   * rows DECLARED above.
   */
  test("baseline diagnostics remain except the declared errors on now-valid repository targets", async () => {
    const rows = await swipe()
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline
    const atMain = Object.values(baseline.rows).filter(([index]) => index !== -1).length
    const here = rows.filter((row) => row.error !== null && baseline.rows[key(row)] !== undefined).length
    const lost = rows.filter((row) => {
      const at = baseline.rows[key(row)]
      return at !== undefined && at[0] !== -1 && row.error === null
    })
    expect(lost.map((row) => `/${row.flow} ${row.args ?? ""}`)).toEqual([
      "/issues codeplanesmithers/canary", "/issues.list codeplanesmithers/canary"
    ])
    /* `here` counts only flows that still exist: the three `change.pick` rows left with the flow (#1904). */
    /* 1448: `/issues.create --nope value` and friends now read the create grammar's own --kind refusal instead of a usage line (smithers-ui-DESIGN.md §3.1). */
    expect({ atMain, here }).toEqual({ atMain: 1437, here: 1448 })
    /*
     * Two doors throw when the one token they are given is a number: the
     * render dispatches a card whose payload the event schema rejects. It is
     * `main@origin`'s, identical at both ends and swept here so the next pass
     * inherits the list rather than the surprise — and so a NINTH throwing
     * row fails this file.
     */
    expect(rows.filter((row) => row.threw !== null).map((row) => `/${row.flow} ${row.args ?? ""}`)).toEqual([
      "/issue.add-flow 7", "/issue.add-flow 0", `/issue.add-flow "hello world"`, "/issue.add-flow 500000",
      "/files.open-diff 7", "/files.open-diff 0", `/files.open-diff "hello world"`, "/files.open-diff 500000"
    ])
  }, 1_800_000)

  test("every declared move states why it is one", () => {
    expect(DECLARED.filter((move) => move.because.trim().length < 40).map((move) => move.flow)).toEqual([])
  })
})
