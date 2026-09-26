/**
 * Distils a wave's journals into the fixture the completion demands replay.
 *
 *   node lib/narrowing-journals.mjs [work-dir] [out-file]
 *
 * The three demands in `@smthrs/harness` that judge a `complete` transition read
 * seven things off a run, and every one of them is already in the journal: the
 * flow and input of every settled call, whether that call succeeded, whether it
 * declared a write, what the call's own result said about its subject's exit
 * status and about whether it ran a check at all, and — per frame — the
 * workspace digest the frame closed on and whether that frame moved the tree.
 * The digest the run *opened* on is read off the `workspace-open` boundary of
 * the first frame. This writes exactly those, so the harness suite can replay a
 * real wave without a database and without the 12 MB of journals that produced
 * it.
 *
 * Three fixtures are committed, and none of them is regenerable:
 *
 * - `packages/smithers/agent/harness/test/fixtures/narrowingJournals.json` — wave 8, the
 *   evidence `NarrowedCheck` was designed against. Wave 9 replaced wave 8's
 *   workspaces, so this file is the last copy of those journals. It predates the
 *   exit-status and mutation fields and is not to be rewritten.
 * - `packages/smithers/agent/harness/test/fixtures/completionJournals.json` — wave 9, the
 *   evidence `UnmovedTree` and `UnresolvedFailure` were designed against.
 * - `packages/smithers/agent/harness/test/fixtures/wave10Journals.json` — wave 10, the first
 *   wave run with all three demands armed, and the evidence
 *   `NarrowedCheck.findOnly` was designed against: its pytest instance ran a
 *   filtered reading of the right file, ran nothing else, and completed, which
 *   is the shape broad-then-narrow cannot see.
 * - `packages/smithers/agent/harness/test/fixtures/vacuousJournals.json` — the r92 full-bench
 *   wave, and the evidence `VacuousVerification` was designed against:
 *   `django__django-14351` stored one verification script as its proof after
 *   having watched that same script exit 0 on the tree it was handed.
 * - `packages/smithers/agent/harness/test/fixtures/r97Journals.json` — the r97 full-bench
 *   wave, written by lib/r97-narrow-only-journals.mjs (a sibling of this
 *   script that also records demand events, the task text, and per-call
 *   checkpoint marks): the evidence the narrow-only demand's taught-terms
 *   condition was measured on.
 *
 * The r92 fixture is the one file here that also carries what a transition
 * stored under `state.verification`, because that is the only thing the newest
 * signal reads which is not already a call.
 *
 * A change to any of the three detectors that starts demanding something of a
 * run those waves resolved has to explain itself against these files rather than
 * against a memory of what a wave once did.
 *
 * `declaredWrites` is per frame rather than per call in the journal, so a call
 * is marked as declaring a write only when its flow is one the wave's own
 * report classes as an edit — the same list `fixtures/make-fixture.mjs` uses.
 * The detectors only ever use the flag to *skip* an entry, so a
 * misclassification here can suppress a demand and cannot invent one.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const work = resolve(process.argv[2] ?? join(here, "..", "work"))
const out = resolve(
  process.argv[3] ??
    join(
      here,
      "..",
      "..",
      "..",
      "packages",
      "smithers",
      "agent",
      "harness",
      "test",
      "fixtures",
      "narrowingJournals.json"
    )
)

/** Flows whose calls change the workspace, so they are never checks. */
const editing = new Set(["write", "edit", "apply_patch"])

/** The reserved result keys the controller reads off an otherwise opaque call. */
const exitStatusKey = "exitCode"
const invalidProbeKey = "invalidProbe"

const reading = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  const status = value[exitStatusKey]
  const probe = value[invalidProbeKey]
  return {
    ...(typeof status === "number" ? { exit: status } : {}),
    ...(probe !== null && typeof probe === "object" && !Array.isArray(probe) ? { probe: true } : {})
  }
}

const distil = (path) => {
  const db = new DatabaseSync(path, { readOnly: true })
  let rows
  try {
    rows = db.prepare(
      "select seq, event_type, payload_json from flows_journal_events"
        + " where event_type like 'control.agent.%' or event_type = 'flows.time-travel.effect-boundary'"
        + " order by seq"
    ).all()
  } finally {
    db.close()
  }
  const frames = []
  const started = []
  let frame
  let openedOn
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    if (row.event_type === "flows.time-travel.effect-boundary") {
      // The run's opening measurement, recorded as the first frame's
      // `workspace-open` boundary. An incomplete walk says nothing about the
      // tree, so it is distilled as no measurement at all.
      const effect = payload.effect
      if (
        openedOn === undefined && effect.kind === "harness/boundary/workspace-open"
        && effect.status === "succeeded" && effect.output?._tag === "Some"
      ) {
        openedOn = effect.output.value.complete ? effect.output.value.digest : ""
      }
      continue
    }
    switch (row.event_type) {
      case "control.agent.turn-opened":
        frame = {
          calls: [],
          basis: "declared",
          digest: "",
          mutated: false,
          transition: "none",
          seq: row.seq
        }
        frames.push(frame)
        break
      case "control.agent.cell-call-started":
        started.push(payload)
        break
      case "control.agent.cell-call-settled": {
        const opened = started.shift()
        frame.calls.push({
          flow: payload.flowName,
          input: opened.input,
          ok: payload.outcome === "success",
          mutates: editing.has(payload.flowName),
          ...(payload.outcome === "success" ? reading(payload.value) : {}),
          seq: row.seq
        })
        break
      }
      case "control.agent.mutation-observed":
        frame.basis = payload.basis
        frame.digest = payload.digest
        frame.mutated = payload.mutated
        break
      case "control.agent.transition-applied": {
        frame.transition = payload.transition._tag
        frame.transitionSeq = row.seq
        // The `{ flow, input }` the cell stored as its proof, which is the one
        // thing `VacuousVerification` reads out of a transition's durable
        // state. Nothing else in the cell's state is distilled: it is the
        // agent's own memory and can hold anything, including file bodies.
        const stored = payload.transition.state
        const declared = stored !== null && typeof stored === "object" && !Array.isArray(stored)
          ? stored.verification
          : undefined
        if (
          declared !== null && typeof declared === "object" && !Array.isArray(declared)
          && typeof declared.flow === "string" && declared.input !== undefined
        ) {
          frame.verification = { flow: declared.flow, input: declared.input }
        }
        break
      }
      default:
        break
    }
  }
  return { openedOn: openedOn ?? "", frames }
}

const instances = readdirSync(work).filter((name) => existsSync(join(work, name, ".flows", "engine.db"))).sort()
const journals = instances.map((instance) => ({
  instance,
  ...distil(join(work, instance, ".flows", "engine.db"))
}))
writeFileSync(out, `${JSON.stringify({ journals }, null, 2)}\n`)
for (const journal of journals) {
  const calls = journal.frames.reduce((total, frame) => total + frame.calls.length, 0)
  console.log(
    `${journal.instance}: ${journal.frames.length} frames, ${calls} calls, opened on ${journal.openedOn.slice(0, 12)}`
  )
}
console.log(`wrote ${out}`)
