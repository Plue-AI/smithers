/**
 * Replays the journal-only candidate selector over two real waves.
 *
 * `select-candidate.mjs` decides which of an instance's n runs is submitted, and
 * it decides it before anything is graded. Two things therefore have to be true
 * of it and are checked here: it reads the four predicates off a journal the way
 * the harness's own detectors read them, and it is deterministic — the same
 * journals choose the same run, every time, on any machine.
 *
 * The candidates are not synthesised. Wave 10 and wave 11 ran the same five
 * instances, both waves' journals were distilled at the time
 * (`packages/smithers/agent/harness/test/fixtures/wave10Journals.json` and
 * `fixtures/wave11-journals.json`), and `fixtures/rehydrate-journals.mjs` turns
 * a distillation back into the database the selector reads. So the
 * two-candidate case below is two real runs of one instance, and the numbers
 * pinned here are what those runs did.
 *
 * Four synthetic candidates are added at the end, and only to reach the
 * tie-breaks: two waves that disagree about a predicate never exercise what
 * happens when they agree about all four.
 *
 * Spends no tokens, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-selector-"))

const instances = [
  "astropy__astropy-8707",
  "django__django-16612",
  "pydata__xarray-7393",
  "pytest-dev__pytest-6197",
  "sphinx-doc__sphinx-11445"
]

const rehydrate = (source, out, index, patches) => {
  const result = spawnSync(
    process.execPath,
    [join(root, "fixtures/rehydrate-journals.mjs"), source, out, index, patches],
    { encoding: "utf8" }
  )
  assert.equal(result.status, 0, result.stderr)
}

const select = (instance, journals, patches, out, extra = []) =>
  spawnSync(
    process.execPath,
    [
      join(root, "select-candidate.mjs"),
      instance,
      "--journals",
      journals,
      "--patches",
      patches,
      "--out",
      out,
      ...extra
    ],
    { encoding: "utf8" }
  )

const rationaleOf = (out, instance) => readFileSync(join(out, `${instance}.rationale.json`), "utf8")

try {
  // -----------------------------------------------------------------------
  // What it can name at all. The flag surface below is one half of the rule;
  // this is the other. Every module the selector loads is a node builtin, the
  // harness's own detectors, the journal reader, or the committed price table
  // — and none of those files names an evaluator report, the dataset, or the
  // graded identifiers, so there is no path to the answer to refuse. These
  // checks read source only, so they run first and no replay red can hide them.
  // -----------------------------------------------------------------------
  /** Where the detectors live. A move of the harness breaks this, not the rule. */
  const harnessSource = resolve(root, "../../packages/smithers/agent/harness/src")
  const rateCard = resolve(root, "../../packages/smithers/agent/model/src/internal/prices.generated.ts")
  const allowed = (from, specifier) => {
    if (specifier.startsWith("node:")) return true
    const target = resolve(root, dirname(from), specifier)
    return target === join(root, "lib/journal-facts.mjs")
      || target === join(root, "lib/journal-rows.mjs")
      || target === join(root, "prices.ts")
      || target === rateCard
      || (dirname(target) === harnessSource && /^[A-Za-z]+\.ts$/u.test(basename(target)))
  }
  assert.ok(allowed("select-candidate.mjs", "../../packages/smithers/agent/harness/src/Sufficiency.ts"))
  assert.ok(allowed("lib/journal-facts.mjs", "../../../packages/smithers/agent/harness/src/NarrowedCheck.ts"))
  assert.ok(
    allowed("prices.ts", "../../packages/smithers/agent/model/src/internal/prices.generated.ts"),
    "the generated rate card"
  )
  assert.ok(
    !allowed("prices.ts", "../../packages/smithers/agent/model/src/internal/prices.ts"),
    "no other model module"
  )
  assert.ok(!allowed("select-candidate.mjs", "../../packages/harness/src/Sufficiency.ts"), "a stale harness path")
  assert.ok(!allowed("select-candidate.mjs", "../../packages/smithers/agent/harness/test/fixtures/r97Journals.json"))

  const forbiddenNames = ["swb-verified", "preds-", "FAIL_TO_PASS", "PASS_TO_PASS", "resolved_ids", "test_patch"]
  // The doc comments say what the selector must never read, so a mention is
  // only a leak when it is not in a comment.
  const codeOf = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//gu, "").split("\n").filter((line) => !line.trimStart().startsWith("//")).join(
      "\n"
    )
  const importsOf = (source) => [...source.matchAll(/^import[^"']*["']([^"']+)["']/gmu)].map((match) => match[1])

  // The name scan runs over every module the selector loads, detectors
  // included, before the import shape is asserted.
  const scanned = new Set()
  const pending = [join(root, "select-candidate.mjs")]
  while (pending.length > 0) {
    const path = pending.pop()
    if (scanned.has(path)) continue
    scanned.add(path)
    const source = readFileSync(path, "utf8")
    const code = codeOf(source)
    for (const forbidden of forbiddenNames) {
      assert.ok(!code.includes(forbidden), `${path} names ${forbidden} outside a comment`)
    }
    for (const specifier of importsOf(source)) {
      if (specifier.startsWith(".")) pending.push(resolve(dirname(path), specifier))
    }
  }
  assert.ok(scanned.has(join(harnessSource, "Sufficiency.ts")), "the scan reaches the detectors")

  for (const name of ["select-candidate.mjs", "lib/journal-facts.mjs", "lib/journal-rows.mjs", "prices.ts"]) {
    for (const specifier of importsOf(readFileSync(join(root, name), "utf8"))) {
      assert.ok(allowed(name, specifier), `${name} imports ${specifier}, which is not a journal, a detector or a price`)
    }
  }

  // -----------------------------------------------------------------------
  // A distillation's instance name is a path component, never a path.
  // -----------------------------------------------------------------------
  const escapeBase = join(temporary, "escape")
  mkdirSync(escapeBase, { recursive: true })
  writeFileSync(
    join(escapeBase, "escape.json"),
    JSON.stringify({ journals: [{ instance: "../escaped", openedOn: "", frames: [] }] })
  )
  const escaped = spawnSync(
    process.execPath,
    [
      join(root, "fixtures/rehydrate-journals.mjs"),
      join(escapeBase, "escape.json"),
      join(escapeBase, "out"),
      "r1",
      join(escapeBase, "patches")
    ],
    { encoding: "utf8" }
  )
  assert.equal(escaped.status, 2, "an instance that is not <repo>__<issue> is refused")
  assert.match(escaped.stderr, /must match <repo>__<issue>/)
  assert.deepEqual(readdirSync(escapeBase), ["escape.json"], "and nothing is written")

  // -----------------------------------------------------------------------
  // Distil over rehydrate: the distiller reads back the frames rehydration
  // wrote.
  // -----------------------------------------------------------------------
  const roundTrip = {
    instance: "round__trip",
    openedOn: "aaaa",
    frames: [
      {
        calls: [{ flow: "bash", input: { command: "check tests/a.py" }, ok: true, mutates: false, exit: 1 }],
        basis: "observed",
        digest: "aaaa",
        mutated: false,
        transition: "continue"
      },
      {
        calls: [{ flow: "write", input: { path: "a.py", text: "x" }, ok: true, mutates: true }],
        basis: "observed",
        digest: "bbbb",
        mutated: true,
        transition: "complete"
      }
    ]
  }
  const roundBase = join(temporary, "round")
  mkdirSync(roundBase, { recursive: true })
  writeFileSync(join(roundBase, "in.json"), JSON.stringify({ journals: [roundTrip] }))
  rehydrate(join(roundBase, "in.json"), join(roundBase, "journals"), "r1", join(roundBase, "patches"))
  mkdirSync(join(roundBase, "work", "round__trip", ".flows"), { recursive: true })
  renameSync(
    join(roundBase, "journals", "round__trip-r1", "engine.db"),
    join(roundBase, "work", "round__trip", ".flows", "engine.db")
  )
  const distilled = spawnSync(
    process.execPath,
    [join(root, "lib/narrowing-journals.mjs"), join(roundBase, "work"), join(roundBase, "out.json")],
    { encoding: "utf8" }
  )
  assert.equal(distilled.status, 0, distilled.stderr)
  const [readBackJournal] = JSON.parse(readFileSync(join(roundBase, "out.json"), "utf8")).journals
  assert.equal(readBackJournal.instance, "round__trip")
  assert.equal(readBackJournal.openedOn, "aaaa")
  assert.deepEqual(
    readBackJournal.frames.map(({ calls, basis, digest, mutated, transition }) => ({
      calls: calls.map(({ seq: _seq, ...call }) => call),
      basis,
      digest,
      mutated,
      transition
    })),
    roundTrip.frames,
    "the distillation reads back what rehydration wrote"
  )

  const journals = join(temporary, "journals")
  const patches = join(temporary, "patches")
  const out = join(temporary, "selected")

  // -----------------------------------------------------------------------
  // One candidate: the choice is that candidate, and its predicates are the
  // ones wave 11 actually earned.
  // -----------------------------------------------------------------------
  rehydrate(join(root, "fixtures/wave11-journals.json"), journals, "r1", patches)

  /**
   * What wave 11's five runs hold, as the four predicates read them.
   *
   * astropy's `cleanCompletion` reads false because its last editing frame
   * (16) ran `pytest -rA astropy/io/fits/tests/test_header.py` AFTER its edit
   * and that check was red; the next frame answered with the same file under
   * `-k fromstring` and completed. That red used to be dropped from the ledger
   * because its frame also edited, so the completion read as clean. Checks now
   * carry the tree they read rather than their frame's, so a reading taken
   * after the frame's last write counts — which is what makes the broad red
   * visible, and the narrow-probe completion it hides is the shape
   * `UnresolvedFailure` exists to name.
   */
  const waveEleven = {
    "astropy__astropy-8707": [true, true, false, false],
    "django__django-16612": [true, true, false, true],
    "pydata__xarray-7393": [true, false, false, false],
    "pytest-dev__pytest-6197": [true, true, true, true],
    "sphinx-doc__sphinx-11445": [true, true, true, true]
  }

  for (const instance of instances) {
    const run = select(instance, journals, patches, out)
    assert.equal(run.status, 0, run.stderr)
    const rationale = JSON.parse(rationaleOf(out, instance))
    assert.equal(rationale.selected, "r1", `${instance}: one candidate is the choice`)
    assert.equal(rationale.candidates.length, 1)
    const [candidate] = rationale.candidates
    assert.deepEqual(
      [
        candidate.predicates.preEditFailure.held,
        candidate.predicates.mutationAfter.held,
        candidate.predicates.greenOverFinalTree.held,
        candidate.predicates.cleanCompletion.held
      ],
      waveEleven[instance],
      `${instance}: wave 11's predicates`
    )
    assert.equal(candidate.score, waveEleven[instance].filter(Boolean).length)
    // Every predicate that holds names the journal event it was read from.
    for (const [name, predicate] of Object.entries(candidate.predicates)) {
      if (predicate.held) {
        assert.equal(typeof predicate.seq, "number", `${instance}: ${name} names its evidence`)
      } else {
        assert.equal(typeof predicate.why, "string", `${instance}: ${name} says why not`)
      }
    }
  }

  // The run that changed nothing is the run that holds the least. Wave 11's
  // xarray issued 24 frames, never moved the tree and never completed.
  const xarray = JSON.parse(rationaleOf(out, "pydata__xarray-7393")).candidates[0]
  assert.equal(xarray.score, 1)
  assert.equal(xarray.predicates.cleanCompletion.held, false)
  assert.match(xarray.predicates.cleanCompletion.why, /never applied a complete transition/)

  // -----------------------------------------------------------------------
  // Two candidates: wave 10 as r2 beside wave 11 as r1, and the choice each
  // instance's two real runs produce.
  // -----------------------------------------------------------------------
  rehydrate(
    join(root, "../../packages/smithers/agent/harness/test/fixtures/wave10Journals.json"),
    journals,
    "r2",
    patches
  )

  /**
   * What the two waves choose, and which key decides it.
   *
   * `score` picks three of the five. The other two agree on all four predicates
   * and are separated by the first tie-break: the broader final check, which is
   * the one with fewer terms.
   */
  const chosen = {
    // Neither astropy run holds a green over the tree it finished on. r1 ran
    // its broad check after its last edit and it was red; r2's last frame to
    // touch the final tree moved it with nothing declaring the write, so none
    // of that frame's four readings can be placed against the move and the
    // closing digest is not a tree any of them read.
    "astropy__astropy-8707": { index: "r2", by: "score", scores: { r1: 2, r2: 3 } },
    "django__django-16612": { index: "r1", by: "score", scores: { r1: 3, r2: 1 } },
    "pydata__xarray-7393": { index: "r1", by: "run index", scores: { r1: 1, r2: 1 } },
    "pytest-dev__pytest-6197": { index: "r2", by: "terms", scores: { r1: 4, r2: 4 }, terms: { r1: 35, r2: 34 } },
    "sphinx-doc__sphinx-11445": { index: "r2", by: "terms", scores: { r1: 4, r2: 4 }, terms: { r1: 122, r2: 53 } }
  }

  for (const instance of instances) {
    const run = select(instance, journals, patches, out)
    assert.equal(run.status, 0, run.stderr)
    const rationale = JSON.parse(rationaleOf(out, instance))
    const expected = chosen[instance]
    assert.equal(rationale.candidates.length, 2, `${instance}: two candidates`)
    assert.equal(rationale.selected, expected.index, `${instance}: chosen by ${expected.by}`)
    assert.equal(rationale.candidates[0].index, expected.index, "the chosen candidate ranks first")
    for (const candidate of rationale.candidates) {
      assert.equal(candidate.score, expected.scores[candidate.index], `${instance} ${candidate.index}: score`)
      if (expected.terms !== undefined) {
        assert.equal(
          candidate.finalCheckTerms,
          expected.terms[candidate.index],
          `${instance} ${candidate.index}: terms`
        )
      }
    }
  }

  // -----------------------------------------------------------------------
  // Determinism: the same journals, twice, byte for byte.
  // -----------------------------------------------------------------------
  const first = instances.map((instance) => rationaleOf(out, instance))
  for (const instance of instances) {
    const run = select(instance, journals, patches, out)
    assert.equal(run.status, 0, run.stderr)
  }
  instances.forEach((instance, position) => {
    assert.equal(rationaleOf(out, instance), first[position], `${instance}: the selection is deterministic`)
  })

  // The selected patch is the chosen run's patch, byte for byte.
  for (const instance of instances) {
    const rationale = JSON.parse(rationaleOf(out, instance))
    assert.equal(
      readFileSync(join(out, `${instance}.patch`), "utf8"),
      readFileSync(join(patches, `${instance}-${rationale.selected}.patch`), "utf8")
    )
  }

  // -----------------------------------------------------------------------
  // The tie-breaks below the first one, which two real waves never reach.
  // -----------------------------------------------------------------------
  const twin = (instance, patchBytes, usage) => ({
    instance,
    openedOn: "aaaa",
    patchBytes,
    usage,
    frames: [
      {
        calls: [{ flow: "bash", input: { command: "check tests/a.py" }, ok: true, mutates: false, exit: 1 }],
        basis: "observed",
        digest: "aaaa",
        mutated: false,
        transition: "continue"
      },
      {
        calls: [{ flow: "write", input: { path: "a.py", text: "x" }, ok: true, mutates: true }],
        basis: "observed",
        digest: "bbbb",
        mutated: true,
        transition: "continue"
      },
      {
        calls: [{ flow: "bash", input: { command: "check tests/a.py" }, ok: true, mutates: false, exit: 0 }],
        basis: "observed",
        digest: "bbbb",
        mutated: false,
        transition: "complete"
      }
    ]
  })

  const tieJournals = join(temporary, "tie-journals")
  const tiePatches = join(temporary, "tie-patches")
  const tieOut = join(temporary, "tie-selected")
  mkdirSync(join(temporary, "tie"), { recursive: true })
  const cost = { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 10_000 }
  const cheaper = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 1_000 }

  // r1 changed nothing worth capturing, r2 did: a non-empty patch wins.
  writeFileSync(
    join(temporary, "tie", "r1.json"),
    JSON.stringify({ journals: [twin("tie__patch", 0, cost), twin("tie__cost", 40, cost)] })
  )
  writeFileSync(
    join(temporary, "tie", "r2.json"),
    JSON.stringify({ journals: [twin("tie__patch", 40, cost), twin("tie__cost", 40, cheaper)] })
  )
  rehydrate(join(temporary, "tie", "r1.json"), tieJournals, "r1", tiePatches)
  rehydrate(join(temporary, "tie", "r2.json"), tieJournals, "r2", tiePatches)

  for (const instance of ["tie__patch", "tie__cost"]) {
    const run = select(instance, tieJournals, tiePatches, tieOut)
    assert.equal(run.status, 0, run.stderr)
    const rationale = JSON.parse(rationaleOf(tieOut, instance))
    assert.deepEqual(rationale.candidates.map((candidate) => candidate.score), [4, 4], `${instance}: the scores tie`)
    assert.deepEqual(
      rationale.candidates.map((candidate) => candidate.finalCheckTerms),
      [3, 3],
      `${instance}: the final checks tie`
    )
    assert.equal(rationale.selected, "r2", `${instance}: the later run wins on the tie-break alone`)
  }
  assert.equal(JSON.parse(rationaleOf(tieOut, "tie__patch")).candidates[1].patchBytes, 0)
  assert.ok(
    JSON.parse(rationaleOf(tieOut, "tie__cost")).candidates[0].usd
      < JSON.parse(rationaleOf(tieOut, "tie__cost")).candidates[1].usd,
    "the cheaper run wins when everything above cost ties"
  )

  // -----------------------------------------------------------------------
  // Two spellings of one run index still have an order.
  //
  // `r1` and `r01` are both legal indexes — `lib/run-paths.sh` accepts
  // `r<digits>` — and they name the same number. Two candidates that tie all
  // the way down to the last key would otherwise compare equal, and which one
  // was chosen would be `readdirSync`'s answer rather than a recorded one.
  // -----------------------------------------------------------------------
  const spelledJournals = join(temporary, "spelled-journals")
  const spelledPatches = join(temporary, "spelled-patches")
  const spelledOut = join(temporary, "spelled-selected")
  writeFileSync(
    join(temporary, "tie", "spelled.json"),
    JSON.stringify({ journals: [twin("tie__spelling", 40, cost)] })
  )
  rehydrate(join(temporary, "tie", "spelled.json"), spelledJournals, "r01", spelledPatches)
  rehydrate(join(temporary, "tie", "spelled.json"), spelledJournals, "r1", spelledPatches)

  const spelledFirst = select("tie__spelling", spelledJournals, spelledPatches, spelledOut)
  assert.equal(spelledFirst.status, 0, spelledFirst.stderr)
  const spelledRationale = JSON.parse(rationaleOf(spelledOut, "tie__spelling"))
  assert.deepEqual(
    spelledRationale.candidates.map((candidate) => candidate.index),
    ["r01", "r1"],
    "two spellings of one number are ordered by the name, not by the directory listing"
  )
  assert.equal(spelledRationale.selected, "r01")
  const spelledAgain = select("tie__spelling", spelledJournals, spelledPatches, spelledOut)
  assert.equal(spelledAgain.status, 0, spelledAgain.stderr)
  assert.equal(
    rationaleOf(spelledOut, "tie__spelling"),
    JSON.stringify(spelledRationale, null, 2) + "\n",
    "and the order is the same the second time"
  )

  // -----------------------------------------------------------------------
  // What it refuses. The selector may only ever name a journal or a patch.
  // -----------------------------------------------------------------------
  const unknown = select(instances[0], journals, patches, out, ["--report", join(root, "flows-cell-harness.w11.json")])
  assert.equal(unknown.status, 2, "an unknown flag is refused, not ignored")
  assert.match(unknown.stderr, /unknown flag --report/)
  assert.match(unknown.stderr, /reads no evaluator report/)

  const asFile = select(instances[0], join(root, "prices.ts"), patches, out)
  assert.equal(asFile.status, 2, "--journals must name a directory")
  assert.match(asFile.stderr, /must name a directory/)

  const missing = select("nothing__here", journals, patches, out)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no archived journal/)

  const twoIds = spawnSync(
    process.execPath,
    [join(root, "select-candidate.mjs"), instances[0], instances[1], "--journals", journals],
    { encoding: "utf8" }
  )
  assert.equal(twoIds.status, 2, "one instance at a time")

  // -----------------------------------------------------------------------
  // The journal it reads is the journal the harness writes.
  //
  // Every case above runs over a rehydrated distillation, so it proves the
  // ranking and not the shape: rename an event or a payload field in
  // `packages/smithers/agent/src/AgentSession.ts` and the fixture would keep passing
  // while every predicate silently read `false` on a real run. The event names
  // and the payload fields `lib/journal-facts.mjs` reads are therefore checked
  // against the one module that writes them.
  // -----------------------------------------------------------------------
  const session = readFileSync(resolve(root, "../../packages/smithers/agent/src/AgentSession.ts"), "utf8")
  const events = readFileSync(resolve(root, "../../packages/smithers/agent/harness/src/AgentEvent.ts"), "utf8")
  // Every event the harness declares, by the tag the journal names it under.
  const declared = new Set(
    [...events.matchAll(/\)\("([a-z][a-z-]+)",\s*\{/gu)].map((match) => `control.agent.${match[1]}`)
  )
  assert.ok(declared.size > 10, "AgentEvent still declares its events as tagged classes")
  // Every event AgentSession maps by hand. The ones it does not reach the
  // journal through its default branch, with an empty payload — which is why
  // reading a field off one is the thing that has to be checked, not reading
  // its name.
  const mapped = new Set([...session.matchAll(/eventType: "(control\.agent\.[a-z-]+)"/gu)].map((match) => match[1]))

  const facts = readFileSync(join(root, "lib/journal-facts.mjs"), "utf8")
  const readBack = [...facts.matchAll(/case "(control\.agent\.[a-z-]+)":/gu)].map((match) => match[1])
  assert.ok(readBack.length > 5, "journal-facts still reads its events by name")
  for (const name of readBack) {
    assert.ok(declared.has(name), `journal-facts reads ${name}, which the harness does not emit`)
  }

  // The events the fold reads *fields* off, rather than counting. Each needs an
  // explicit mapping, because the default branch journals an empty payload and
  // every predicate would quietly read `false` off one.
  const withFields = [
    "control.agent.turn-opened",
    "control.agent.model-settled",
    "control.agent.cell-call-started",
    "control.agent.cell-call-settled",
    "control.agent.mutation-observed",
    "control.agent.transition-applied"
  ]
  for (const name of withFields) {
    assert.ok(readBack.includes(name), `journal-facts stopped reading ${name}`)
    assert.ok(mapped.has(name), `${name} reaches the journal with an empty payload`)
  }
  // The fields themselves: the seat that prices the run, the call's flow and
  // result, and the frame's own measurement of the tree. What matters is that
  // each one is written OFF THE EVENT; `input`, `value` and `transition` reach
  // the payload through a bounding wrapper (`tracedField`, `tracedTransition`)
  // rather than bare, so one call around the event read is allowed. A field
  // that stopped naming `event.` at all still fails, which is the drift this
  // guards: journal-facts would read it as absent and every predicate would
  // quietly go false.
  for (const field of ["seat", "flowName", "input", "outcome", "value", "basis", "mutated", "digest", "transition"]) {
    assert.match(
      session,
      new RegExp(`\\b${field}: (?:[A-Za-z][A-Za-z0-9]*\\()?event\\.`, "u"),
      `AgentSession no longer writes ${field}, which journal-facts reads`
    )
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-selector.mjs: two real waves rank as recorded, and the selection is deterministic.")
